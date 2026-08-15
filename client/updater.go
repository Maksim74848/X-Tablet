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

const currentXTabletVersion = "1.0.24"

type updateInfo struct {
	Version string `json:"version"`
	URL     string `json:"url"`
	Notes   string `json:"notes"`
}

func init() {
	go func() {
		time.Sleep(12 * time.Second)

		for {
			checkForUpdate()

			time.Sleep(
				30 * time.Minute,
			)
		}
	}()
}

func checkForUpdate() {

	if runtime.GOOS != "windows" {
		return
	}

	api := compiledLicenseServerURL

	req, err :=
		http.NewRequest(
			http.MethodGet,
			api+"/v1/update/latest?version="+
				currentXTabletVersion,
			nil,
		)

	if err != nil {
		return
	}

	client :=
		&http.Client{
			Timeout:
				10 * time.Second,
		}

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

	var info updateInfo

	if err :=
		json.NewDecoder(
			resp.Body,
		).Decode(
			&info,
		); err != nil {
		return
	}

	if info.Version == "" ||
		info.URL == "" {
		return
	}

	if !isNewerVersion(
		currentXTabletVersion,
		info.Version,
	) {
		return
	}

	if err :=
		installUpdate(
			info.URL,
	); err != nil {
		fmt.Println(
			"X-Tablet update:",
			err
		)
	}
}

func isNewerVersion(
	current,
	latest string,
) bool {

	parse := func(
		v string,
	) [3]int {

		v =
			strings.TrimPrefix(
				v,
				"v",
			)

		parts :=
			strings.Split(
				v,
				".",
			)

		var out [3]int

		for i := 0; i < 3 && i < len(parts); i++ {
			n, _ :=
				strconv.Atoi(
					parts[i]
				)

			out[i] = n
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

func installUpdate(
	url string,
) error {

	resp, err :=
		http.Get(url)

	if err != nil {
		return err
	}

	defer resp.Body.Close()

	if resp.StatusCode !=
		http.StatusOK {
		return fmt.Errorf(
			"update download: HTTP %d",
			resp.StatusCode,
		)
	}

	tmpDir :=
		os.TempDir()

	setupPath :=
		filepath.Join(
			tmpDir,
			"X-Tablet-Update.exe",
		)

	file, err :=
		os.Create(
			setupPath
		)

	if err != nil {
		return err
	}

	_, copyErr :=
		io.Copy(
			file,
			resp.Body
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
			setupPath,
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
