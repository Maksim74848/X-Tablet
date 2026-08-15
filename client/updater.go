package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

var buildVersion = "0.0.0"

const releaseAPI =
	"https://api.github.com/repos/Maksim74848/X-Tablet/releases/latest"

func init() {
	if runtime.GOOS != "windows" {
		return
	}

	go func() {
		time.Sleep(15 * time.Second)
		checkForXTabletUpdate()
	}()
}

type githubRelease struct {
	TagName string `json:"tag_name"`

	Assets []struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
	} `json:"assets"`
}

func checkForXTabletUpdate() {

	if buildVersion == "0.0.0" ||
		buildVersion == "dev" {
		return
	}

	client :=
		&http.Client{
			Timeout:
				12 * time.Second,
		}

	req, err :=
		http.NewRequest(
			http.MethodGet,
			releaseAPI,
			nil,
		)

	if err != nil {
		return
	}

	req.Header.Set(
		"Accept",
		"application/vnd.github+json",
	)

	req.Header.Set(
		"User-Agent",
		"X-Tablet-Updater/"+buildVersion,
	)

	resp, err :=
		client.Do(req)

	if err != nil {
		return
	}

	defer resp.Body.Close()

	if resp.StatusCode !=
		http.StatusOK {
		return
	}

	var release githubRelease

	if err :=
		json.NewDecoder(
			resp.Body,
		).Decode(
			&release,
		); err != nil {
		return
	}

	latest :=
		strings.TrimPrefix(
			strings.TrimSpace(
				release.TagName,
			),
			"v",
		)

	if !isVersionGreater(
		buildVersion,
		latest,
	) {
		return
	}

	var installerURL string

	for _, asset :=
		range release.Assets {

		if asset.Name ==
			"X-Tablet-Windows-Setup.exe" {

			installerURL =
				asset.BrowserDownloadURL

			break
		}
	}

	if installerURL == "" {
		return
	}

	if err :=
		downloadAndRunInstaller(
			installerURL,
		); err != nil {

		fmt.Println(
			"X-Tablet updater:",
			err,
		)
	}
}

func isVersionGreater(
	current,
	latest string,
) bool {

	parse :=
		func(
			value string,
		) [3]int {

			value =
				strings.TrimPrefix(
					strings.TrimSpace(
						value,
					),
					"v",
				)

			parts :=
				strings.Split(
					value,
					".",
				)

			var out [3]int

			for i := 0;
				i < len(parts) &&
					i < 3;
				i++ {

				n, _ :=
					strconv.Atoi(
						parts[i],
					)

				out[i] =
					n
			}

			return out
		}

	a :=
		parse(current)

	b :=
		parse(latest)

	for i := 0; i < 3; i++ {

		if b[i] > a[i] {
			return true
		}

		if b[i] < a[i] {
			return false
		}
	}

	return false
}

func downloadAndRunInstaller(
	url string,
) error {

	client :=
		&http.Client{
			Timeout:
				5 * time.Minute,
		}

	req, err :=
		http.NewRequest(
			http.MethodGet,
			url,
			nil,
		)

	if err != nil {
		return err
	}

	req.Header.Set(
		"User-Agent",
		"X-Tablet-Updater/"+buildVersion,
	)

	resp, err :=
		client.Do(req)

	if err != nil {
		return err
	}

	defer resp.Body.Close()

	if resp.StatusCode < 200 ||
		resp.StatusCode >= 300 {

		return fmt.Errorf(
			"installer download: HTTP %d",
			resp.StatusCode,
		)
	}

	path :=
		filepath.Join(
			os.TempDir(),
			"X-Tablet-Update.exe",
		)

	file, err :=
		os.Create(path)

	if err != nil {
		return err
	}

	_, copyErr :=
		io.Copy(
			file,
			resp.Body,
		)

	closeErr :=
		file.Close()

	if copyErr != nil {
		return copyErr
	}

	if closeErr != nil {
		return closeErr
	}

	cmd :=
		exec.Command(
			path,
			"/VERYSILENT",
			"/SUPPRESSMSGBOXES",
			"/NORESTART",
			"/CLOSEAPPLICATIONS",
			"/RESTARTAPPLICATIONS",
		)

	if err :=
		cmd.Start(); err != nil {
		return err
	}

	os.Exit(0)

	return nil
}
