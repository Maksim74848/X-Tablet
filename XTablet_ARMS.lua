--[[
=====================================================================
 X-TABLET ARMS FLIGHT CORE
 X-Plane 12 / FlyWithLua
 Single-file aircraft assistant + virtual tablet + ARMS monitor

 INSTALL:
   X-Plane 12/
      Resources/
         plugins/
            FlyWithLua/
               Scripts/
                  XTablet_ARMS.lua

 IMPORTANT:
   This script is an ASSISTANT / MONITOR.
   It does NOT autonomously fly the aircraft.
   It does not move yoke/elevator/rudder/throttle by itself.

 FEATURES:
   - ARMS safety monitor
   - Flight phase detection
   - Trend prediction
   - Overspeed / stall / sink / pitch / bank warnings
   - Autopilot / Flight Director monitor
   - Virtual tablet overlay
   - 737-oriented checklists
   - Flight assistance
   - Navigation monitor
   - Custom X-Plane commands
   - Event log
   - Checklist progression
   - Aircraft-independent core

 KEY COMMANDS (assign in X-Plane):
   x_tablet/toggle
   x_tablet/next_page
   x_tablet/previous_page
   x_tablet/next_checklist
   x_tablet/check_item
   x_tablet/reset_checklist
   x_tablet/mute_warnings
   x_tablet/arms_toggle
   x_tablet/assistant_toggle
   x_tablet/log_event
=====================================================================
]]

------------------------------------------------------------
-- CONFIG
------------------------------------------------------------

local CFG = {
    enabled               = true,
    tablet_visible        = true,
    tablet_page           = 1,

    arms_enabled          = true,
    assistant_enabled     = true,
    warnings_enabled      = true,
    sound_enabled         = false,

    tablet_x              = 35,
    tablet_y              = 45,
    tablet_w              = 510,
    tablet_h              = 325,

    refresh_hz             = 10,

    -- Generic flight safety thresholds.
    -- These are intentionally conservative generic thresholds.
    overspeed_kts          = 340,
    extreme_pitch_up       = 20,
    extreme_pitch_down     = -12,
    extreme_bank           = 55,

    excessive_sink_fpm     = -2500,
    severe_sink_fpm        = -4000,

    low_speed_margin       = 1.18,
    critical_speed_margin  = 1.08,

    stall_warning_alpha    = 12.0,
    stall_critical_alpha   = 16.0,

    climb_phase_alt        = 1500,
    cruise_phase_alt       = 5000,

    prediction_seconds     = 5,

    max_log_entries        = 30,
}

------------------------------------------------------------
-- INTERNAL STATE
------------------------------------------------------------

local STATE = {
    page = 1,
    checklist_index = 1,
    checklist_item = 1,

    last_update = 0,
    last_phase = "PARKED",

    airspeed_prev = 0,
    altitude_prev = 0,
    vs_prev = 0,

    airspeed_trend = 0,
    altitude_trend = 0,
    vs_trend = 0,

    risk_level = 0,

    warning = "",
    warning_level = 0,
    warning_timer = 0,

    muted = false,

    event_log = {},

    flight_time = 0,

    auto_checked = {},

    ap_latched = false,
    fd_latched = false,

    initialized = false,
}

------------------------------------------------------------
-- COLORS
------------------------------------------------------------

local COLORS = {
    white   = {1.00, 1.00, 1.00, 1.00},
    gray    = {0.65, 0.68, 0.72, 1.00},
    dim     = {0.38, 0.40, 0.44, 1.00},

    green   = {0.20, 1.00, 0.35, 1.00},
    yellow  = {1.00, 0.80, 0.10, 1.00},
    orange  = {1.00, 0.45, 0.05, 1.00},
    red     = {1.00, 0.15, 0.10, 1.00},
    cyan    = {0.15, 0.90, 1.00, 1.00},
    blue    = {0.15, 0.35, 0.90, 1.00},

    black   = {0.03, 0.04, 0.06, 0.95},
    panel   = {0.05, 0.07, 0.10, 0.94},
    panel2  = {0.08, 0.11, 0.16, 0.97},
    border  = {0.18, 0.25, 0.34, 1.00},
}

------------------------------------------------------------
-- SAFE HELPERS
------------------------------------------------------------

local function clamp(v, lo, hi)
    if v < lo then return lo end
    if v > hi then return hi end
    return v
end

local function abs(v)
    if v < 0 then return -v end
    return v
end

local function sign(v)
    if v < 0 then return -1 end
    if v > 0 then return 1 end
    return 0
end

local function fmt(v, decimals)
    if v == nil then
        return "---"
    end

    decimals = decimals or 0

    if decimals == 0 then
        return string.format("%.0f", v)
    end

    return string.format("%." .. tostring(decimals) .. "f", v)
end

local function bool_text(v)
    return v and "ON" or "OFF"
end

local function safe_log(msg)
    if logMsg then
        logMsg("[XTablet ARMS] " .. tostring(msg))
    end
end

------------------------------------------------------------
-- DATAREFS
--
-- These are standard X-Plane datarefs.
------------------------------------------------------------

-- Position / attitude
dataref("xt_altitude_ft",
        "sim/cockpit2/gauges/indicators/altitude_ft_pilot",
        "readonly")

dataref("xt_ias_kts",
        "sim/cockpit2/gauges/indicators/airspeed_kts_pilot",
        "readonly")

dataref("xt_groundspeed_kts",
        "sim/flightmodel/position/groundspeed",
        "readonly")

dataref("xt_pitch",
        "sim/flightmodel/position/theta",
        "readonly")

dataref("xt_roll",
        "sim/flightmodel/position/phi",
        "readonly")

dataref("xt_heading",
        "sim/flightmodel/position/psi",
        "readonly")

dataref("xt_vs_fpm",
        "sim/cockpit2/gauges/indicators/vvi_fpm_pilot",
        "readonly")

dataref("xt_aoa",
        "sim/flightmodel/position/alpha",
        "readonly")

-- Engine / energy
dataref("xt_throttle_1",
        "sim/cockpit2/engine/actuators/throttle_ratio[0]",
        "readonly")

dataref("xt_throttle_2",
        "sim/cockpit2/engine/actuators/throttle_ratio[1]",
        "readonly")

-- Gear
dataref("xt_gear_deployed",
        "sim/flightmodel2/gear/deploy_ratio[0]",
        "readonly")

-- Flaps
dataref("xt_flap_ratio",
        "sim/flightmodel2/controls/flap_handle_deploy_ratio",
        "readonly")

-- Autopilot modes
dataref("xt_ap_mode",
        "sim/cockpit2/autopilot/autopilot_state",
        "readonly")

dataref("xt_fd_pitch",
        "sim/cockpit2/autopilot/flight_director_pitch",
        "readonly")

dataref("xt_fd_roll",
        "sim/cockpit2/autopilot/flight_director_roll",
        "readonly")

dataref("xt_ap_altitude",
        "sim/cockpit2/autopilot/altitude_dial_ft",
        "readonly")

dataref("xt_ap_heading",
        "sim/cockpit2/autopilot/heading_dial_deg_mag_pilot",
        "readonly")

dataref("xt_ap_vs",
        "sim/cockpit2/autopilot/vvi_dial_fpm",
        "readonly")

-- Radios / navigation
dataref("xt_nav1_freq",
        "sim/cockpit/radios/nav1_freq_hz",
        "readonly")

dataref("xt_nav2_freq",
        "sim/cockpit/radios/nav2_freq_hz",
        "readonly")

dataref("xt_adf_freq",
        "sim/cockpit/radios/adf1_freq_hz",
        "readonly")

------------------------------------------------------------
-- CHECKLIST DATABASE
------------------------------------------------------------

local CHECKLISTS = {

    {
        name = "PRE-FLIGHT",
        code = "PREFLT",
        items = {
            "Parking brake ........ SET",
            "Battery / electrical ... CHECK",
            "Hydraulic systems ...... CHECK",
            "Fuel quantity .......... CHECK",
            "IRS / ADIRU ............ CHECK",
            "Oxygen .................. CHECK",
            "Emergency equipment .... CHECK",
            "Fire protection ........ CHECK",
            "Flight controls ........ FREE",
            "Trim .................... SET",
            "Flaps ................... SET",
            "Speedbrake .............. DOWN",
        }
    },

    {
        name = "BEFORE START",
        code = "START",
        items = {
            "Doors ................... CLOSED",
            "Beacon .................. ON",
            "Anti-collision ......... CHECK",
            "Pushback clearance ..... OBTAIN",
            "Ground equipment ....... CLEAR",
            "Transponder ............ SET",
            "Flight instruments ..... CHECK",
            "Takeoff data ........... REVIEW",
        }
    },

    {
        name = "AFTER START",
        code = "AFTER",
        items = {
            "Generators ............. CHECK",
            "Hydraulics ............. CHECK",
            "Anti-ice ................ AS REQUIRED",
            "Flight controls ........ CHECK",
            "Rudder / aileron ....... CHECK",
            "Trim .................... TAKEOFF",
            "Flaps ................... SET",
        }
    },

    {
        name = "TAXI",
        code = "TAXI",
        items = {
            "Taxi clearance .......... CONFIRMED",
            "Brakes .................. CHECK",
            "Flight instruments ..... CHECK",
            "Flight controls ........ CHECK",
            "Takeoff briefing ....... COMPLETE",
            "Runway / SID ............ CONFIRMED",
        }
    },

    {
        name = "BEFORE TAKEOFF",
        code = "TO",
        items = {
            "Flaps ................... SET",
            "Stabilizer trim ........ SET",
            "Flight controls ........ CHECKED",
            "Autobrake ............... RTO",
            "Speedbrake .............. ARM",
            "Landing lights .......... ON",
            "Taxi light .............. AS REQUIRED",
            "Takeoff configuration ... CHECK",
        }
    },

    {
        name = "CLIMB",
        code = "CLIMB",
        items = {
            "Positive rate ........... CONFIRM",
            "Gear .................... UP",
            "Flaps ................... RETRACT",
            "VNAV / profile .......... CHECK",
            "Speed restriction ....... CHECK",
            "Anti-ice ................ AS REQUIRED",
            "Landing lights .......... AS REQUIRED",
        }
    },

    {
        name = "CRUISE",
        code = "CRUISE",
        items = {
            "Cruise altitude ......... CHECK",
            "Autopilot ............... MONITOR",
            "Fuel balance ............ CHECK",
            "Engine parameters ....... CHECK",
            "Cabin / passengers ...... MONITOR",
            "Route / navigation ...... CHECK",
            "Weather / turbulence .... CHECK",
        }
    },

    {
        name = "DESCENT",
        code = "DESCENT",
        items = {
            "Descent clearance ....... CONFIRMED",
            "Approach briefing ...... COMPLETE",
            "Landing data ............ REVIEW",
            "Weather ................. CHECK",
            "Minimums ................ REVIEW",
            "Approach frequency ...... SET",
            "ILS / RNAV .............. SET",
            "Speed / altitude ........ REVIEW",
        }
    },

    {
        name = "APPROACH",
        code = "APP",
        items = {
            "Approach type ........... CONFIRMED",
            "Localizer / course ..... SET",
            "Glideslope / VNAV ...... CHECK",
            "Landing gear ............ DOWN",
            "Flaps ................... CONFIGURE",
            "Landing checklist ...... COMPLETE",
            "Autobrake ............... SET",
            "Speedbrake .............. ARM",
            "Landing lights .......... ON",
        }
    },

    {
        name = "LANDING",
        code = "LAND",
        items = {
            "Landing configuration ... CHECK",
            "VREF .................... SET / CONFIRM",
            "Gear .................... DOWN",
            "Flaps ................... LANDING",
            "Autopilot ............... AS REQUIRED",
            "Stable approach ........ CONFIRM",
            "Runway .................. CONFIRM",
        }
    },

    {
        name = "SHUTDOWN",
        code = "SHUT",
        items = {
            "Parking brake ........... SET",
            "Engine shutdown ........ COMPLETE",
            "Fuel pumps .............. AS REQUIRED",
            "Hydraulic systems ...... OFF / SET",
            "Beacon .................. AS REQUIRED",
            "Anti-collision ......... OFF",
            "Seat belt signs ........ AS REQUIRED",
            "Exterior lighting ...... SET",
            "Electrical power ....... SET",
        }
    },
}

------------------------------------------------------------
-- EVENT LOG
------------------------------------------------------------

local function add_log(msg)
    local t = os.date("%H:%M:%S")

    table.insert(
        STATE.event_log,
        1,
        {
            time = t,
            text = tostring(msg)
        }
    )

    while #STATE.event_log > CFG.max_log_entries do
        table.remove(STATE.event_log)
    end

    safe_log(msg)
end

------------------------------------------------------------
-- FLIGHT PHASE
------------------------------------------------------------

local function detect_phase()

    local alt = xt_altitude_ft or 0
    local ias = xt_ias_kts or 0
    local vs  = xt_vs_fpm or 0

    if alt < 50 and ias < 30 then
        return "PARKED"
    end

    if alt < 1000 and vs > 300 then
        return "TAKEOFF"
    end

    if alt < 5000 and vs > 200 then
        return "CLIMB"
    end

    if alt >= CFG.cruise_phase_alt and abs(vs) < 500 then
        return "CRUISE"
    end

    if alt > 1000 and vs < -300 then
        return "DESCENT"
    end

    if alt < 2500 and ias > 70 and vs < -100 then
        return "APPROACH"
    end

    if alt < 1500 and ias < 180 and vs < -50 then
        return "LANDING"
    end

    if alt < 1000 then
        return "LOW ALT"
    end

    return STATE.last_phase
end

------------------------------------------------------------
-- TRENDS
------------------------------------------------------------

local function update_trends(dt)

    dt = math.max(dt, 0.05)

    local ias = xt_ias_kts or 0
    local alt = xt_altitude_ft or 0
    local vs  = xt_vs_fpm or 0

    local raw_ias_trend = (ias - STATE.airspeed_prev) / dt
    local raw_alt_trend = (alt - STATE.altitude_prev) / dt
    local raw_vs_trend  = (vs  - STATE.vs_prev) / dt

    STATE.airspeed_trend =
        STATE.airspeed_trend * 0.8 +
        raw_ias_trend * 0.2

    STATE.altitude_trend =
        STATE.altitude_trend * 0.8 +
        raw_alt_trend * 0.2

    STATE.vs_trend =
        STATE.vs_trend * 0.8 +
        raw_vs_trend * 0.2

    STATE.airspeed_prev = ias
    STATE.altitude_prev = alt
    STATE.vs_prev = vs
end

------------------------------------------------------------
-- PREDICTIVE VALUES
------------------------------------------------------------

local function predicted_values()

    local t = CFG.prediction_seconds

    local p_ias =
        (xt_ias_kts or 0) +
        (STATE.airspeed_trend or 0) * t

    local p_alt =
        (xt_altitude_ft or 0) +
        (STATE.altitude_trend or 0) * t

    local p_vs =
        (xt_vs_fpm or 0) +
        (STATE.vs_trend or 0) * t

    return p_ias, p_alt, p_vs
end

------------------------------------------------------------
-- RISK ENGINE
------------------------------------------------------------

local function set_warning(level, text)

    if level <= 0 then
        return
    end

    if level >= STATE.warning_level or STATE.warning == "" then
        STATE.warning = text
        STATE.warning_level = level
        STATE.warning_timer = 4
    end
end

local function reset_warning()

    if STATE.warning_timer > 0 then
        STATE.warning_timer = STATE.warning_timer - 0.1
        return
    end

    STATE.warning = ""
    STATE.warning_level = 0
end

local function run_risk_engine()

    STATE.risk_level = 0

    local ias = xt_ias_kts or 0
    local alt = xt_altitude_ft or 0
    local pitch = xt_pitch or 0
    local roll = xt_roll or 0
    local vs = xt_vs_fpm or 0
    local aoa = xt_aoa or 0
    local phase = STATE.last_phase

    --------------------------------------------------------
    -- OVERSPEED
    --------------------------------------------------------

    if ias > CFG.overspeed_kts then
        STATE.risk_level = math.max(STATE.risk_level, 3)

        set_warning(
            3,
            "OVERSPEED  REDUCE ENERGY"
        )
    end

    --------------------------------------------------------
    -- EXTREME PITCH
    --------------------------------------------------------

    if pitch > CFG.extreme_pitch_up then
        STATE.risk_level = math.max(STATE.risk_level, 2)

        set_warning(
            2,
            "EXCESSIVE PITCH UP"
        )
    end

    if pitch < CFG.extreme_pitch_down then
        STATE.risk_level = math.max(STATE.risk_level, 2)

        set_warning(
            2,
            "EXCESSIVE PITCH DOWN"
        )
    end

    --------------------------------------------------------
    -- BANK
    --------------------------------------------------------

    if abs(roll) > CFG.extreme_bank then
        STATE.risk_level = math.max(STATE.risk_level, 2)

        set_warning(
            2,
            "EXCESSIVE BANK"
        )
    end

    --------------------------------------------------------
    -- SINK RATE
    --------------------------------------------------------

    if vs < CFG.severe_sink_fpm then

        STATE.risk_level = math.max(STATE.risk_level, 3)

        set_warning(
            3,
            "PULL UP / EXCESSIVE SINK"
        )

    elseif vs < CFG.excessive_sink_fpm and alt < 10000 then

        STATE.risk_level = math.max(STATE.risk_level, 2)

        set_warning(
            2,
            "HIGH SINK RATE"
        )
    end

    --------------------------------------------------------
    -- LOW ALTITUDE + SINK
    --------------------------------------------------------

    if alt < 1000 and alt > 50 and vs < -700 then

        STATE.risk_level = math.max(STATE.risk_level, 3)

        set_warning(
            3,
            "TERRAIN RISK / LOW ALT"
        )
    end

    --------------------------------------------------------
    -- HIGH AOA
    --------------------------------------------------------

    if aoa > CFG.stall_critical_alpha then

        STATE.risk_level = math.max(STATE.risk_level, 3)

        set_warning(
            3,
            "STALL RISK / HIGH AOA"
        )

    elseif aoa > CFG.stall_warning_alpha then

        STATE.risk_level = math.max(STATE.risk_level, 2)

        set_warning(
            2,
            "HIGH AOA"
        )
    end

    --------------------------------------------------------
    -- PREDICTION
    --------------------------------------------------------

    local p_ias, p_alt, p_vs = predicted_values()

    if p_ias < 80 and ias > 90 and alt > 1000 then

        STATE.risk_level = math.max(STATE.risk_level, 2)

        set_warning(
            2,
            "PREDICTED LOW AIRSPEED"
        )
    end

    if p_alt < 500 and alt > 500 and vs < -300 then

        STATE.risk_level = math.max(STATE.risk_level, 2)

        set_warning(
            2,
            "PREDICTED LOW ALTITUDE"
        )
    end

    --------------------------------------------------------
    -- TAKEOFF / LANDING MONITOR
    --------------------------------------------------------

    if phase == "TAKEOFF" and ias > 90 and (xt_gear_deployed or 0) > 0.5 then

        STATE.risk_level = math.max(STATE.risk_level, 1)

        set_warning(
            1,
            "GEAR STILL DOWN"
        )
    end

    if phase == "LANDING" and alt < 1500 and ias > 230 and (xt_flap_ratio or 0) < 0.1 then

        STATE.risk_level = math.max(STATE.risk_level, 1)

        set_warning(
            1,
            "CHECK LANDING CONFIG"
        )
    end
end

------------------------------------------------------------
-- AUTOPILOT MONITOR
------------------------------------------------------------

local function get_ap_text()

    local s = xt_ap_mode or 0

    if s == 0 then
        return "OFF"
    elseif s == 1 then
        return "FD"
    elseif s == 2 then
        return "AP"
    else
        return "STATE " .. tostring(s)
    end
end

local function get_ap_advice()

    local ap = xt_ap_mode or 0
    local pitch = xt_pitch or 0
    local vs = xt_vs_fpm or 0
    local target_alt = xt_ap_altitude or 0
    local alt = xt_altitude_ft or 0

    if ap == 0 then
        return "AP OFF — MANUAL FLIGHT"
    end

    if target_alt > alt + 300 and vs < 100 then
        return "TARGET ABOVE / CHECK VERTICAL MODE"
    end

    if target_alt < alt - 300 and vs > -100 then
        return "TARGET BELOW / CHECK VERTICAL MODE"
    end

    if pitch > 15 and vs < 100 then
        return "PITCH HIGH / SPEED MAY DECAY"
    end

    if pitch < -8 and vs > -300 then
        return "PITCH LOW / CHECK ENERGY"
    end

    return "AP PARAMETERS NORMAL"
end

------------------------------------------------------------
-- ASSISTANT
------------------------------------------------------------

local function assistant_message()

    local phase = STATE.last_phase

    local ias = xt_ias_kts or 0
    local alt = xt_altitude_ft or 0
    local vs = xt_vs_fpm or 0

    if STATE.warning ~= "" and STATE.warning_level >= 2 then
        return STATE.warning
    end

    if phase == "TAKEOFF" then

        if (xt_gear_deployed or 0) > 0.4 and alt > 1000 then
            return "CLIMB / GEAR UP"
        end

        return "TAKEOFF MONITOR"
    end

    if phase == "CLIMB" then

        if vs < 500 then
            return "CHECK CLIMB PROFILE"
        end

        return "CLIMB PROFILE OK"
    end

    if phase == "CRUISE" then
        return "CRUISE MONITOR"
    end

    if phase == "DESCENT" then

        if vs > -500 then
            return "DESCENT RATE LOW"
        end

        return "DESCENT MONITOR"
    end

    if phase == "APPROACH" then

        if ias > 210 then
            return "APPROACH SPEED HIGH"
        end

        return "APPROACH MONITOR"
    end

    if phase == "LANDING" then
        return "STABLE APPROACH CHECK"
    end

    if phase == "LOW ALT" then
        return "LOW ALTITUDE — MONITOR ENERGY"
    end

    return "SYSTEM READY"
end

------------------------------------------------------------
-- AUTO CHECKLIST SELECTION
------------------------------------------------------------

local function select_checklist_for_phase(phase)

    local target = nil

    if phase == "PARKED" then
        target = 1
    elseif phase == "TAKEOFF" then
        target = 5
    elseif phase == "CLIMB" then
        target = 6
    elseif phase == "CRUISE" then
        target = 7
    elseif phase == "DESCENT" then
        target = 8
    elseif phase == "APPROACH" then
        target = 9
    elseif phase == "LANDING" then
        target = 10
    end

    if target and target ~= STATE.checklist_index then

        STATE.checklist_index = target
        STATE.checklist_item = 1

        add_log(
            "Checklist changed: " ..
            CHECKLISTS[target].name
        )
    end
end

------------------------------------------------------------
-- CHECKLIST HELPERS
------------------------------------------------------------

local function current_checklist()

    return CHECKLISTS[STATE.checklist_index]
end

local function is_item_checked(index)

    local key =
        tostring(STATE.checklist_index) ..
        ":" ..
        tostring(index)

    return STATE.auto_checked[key] == true
end

local function set_item_checked(index, value)

    local key =
        tostring(STATE.checklist_index) ..
        ":" ..
        tostring(index)

    STATE.auto_checked[key] = value
end

local function check_current_item()

    local c = current_checklist()

    if not c then
        return
    end

    if STATE.checklist_item > #c.items then
        return
    end

    set_item_checked(
        STATE.checklist_item,
        true
    )

    add_log(
        "Checklist: " ..
        c.name ..
        " / item " ..
        tostring(STATE.checklist_item)
    )

    STATE.checklist_item =
        STATE.checklist_item + 1

    if STATE.checklist_item > #c.items then
        add_log(
            "Checklist COMPLETE: " ..
            c.name
        )
    end
end

local function reset_current_checklist()

    local c = current_checklist()

    if not c then
        return
    end

    for i = 1, #c.items do
        set_item_checked(i, false)
    end

    STATE.checklist_item = 1

    add_log(
        "Checklist reset: " ..
        c.name
    )
end

local function next_checklist()

    STATE.checklist_index =
        STATE.checklist_index + 1

    if STATE.checklist_index > #CHECKLISTS then
        STATE.checklist_index = 1
    end

    STATE.checklist_item = 1

    add_log(
        "Checklist selected: " ..
        CHECKLISTS[STATE.checklist_index].name
    )
end

------------------------------------------------------------
-- DRAW HELPERS
------------------------------------------------------------

local function set_color(c)
    glColor4f(
        c[1],
        c[2],
        c[3],
        c[4]
    )
end

local function draw_rect(x1, y1, x2, y2, c)

    set_color(c)

    glBegin_TRIANGLES()

    glVertex2f(x1, y1)
    glVertex2f(x2, y1)
    glVertex2f(x2, y2)

    glVertex2f(x1, y1)
    glVertex2f(x2, y2)
    glVertex2f(x1, y2)

    glEnd()
end

local function draw_text(x, y, text, c, size)

    set_color(c)

    if size then
        draw_string_Helvetica_14(
            x,
            y,
            tostring(text)
        )
    else
        draw_string(
            x,
            y,
            tostring(text)
        )
    end
end

local function draw_line(x1, y1, x2, y2, c)
    set_color(c)

    glBegin_LINES()
    glVertex2f(x1, y1)
    glVertex2f(x2, y2)
    glEnd()
end

------------------------------------------------------------
-- MAIN TABLET FRAME
------------------------------------------------------------

local function draw_tablet_frame()

    local x = CFG.tablet_x
    local y = CFG.tablet_y
    local w = CFG.tablet_w
    local h = CFG.tablet_h

    draw_rect(
        x,
        y,
        x + w,
        y + h,
        COLORS.black
    )

    draw_rect(
        x + 5,
        y + 5,
        x + w - 5,
        y + h - 5,
        COLORS.panel
    )

    draw_rect(
        x + 5,
        y + h - 42,
        x + w - 5,
        y + h - 5,
        COLORS.panel2
    )

    draw_text(
        x + 20,
        y + h - 27,
        "X-TABLET FLIGHT CORE",
        COLORS.cyan
    )

    draw_text(
        x + w - 120,
        y + h - 27,
        "ARMS " .. (CFG.arms_enabled and "ON" or "OFF"),
        CFG.arms_enabled and COLORS.green or COLORS.gray
    )
end

------------------------------------------------------------
-- PAGE 1: OVERVIEW
------------------------------------------------------------

local function draw_overview()

    local x = CFG.tablet_x + 20
    local y = CFG.tablet_y + CFG.tablet_h - 70

    draw_text(
        x,
        y,
        "FLIGHT OVERVIEW",
        COLORS.white
    )

    y = y - 28

    draw_text(
        x,
        y,
        "PHASE",
        COLORS.gray
    )

    draw_text(
        x + 100,
        y,
        STATE.last_phase,
        COLORS.cyan
    )

    y = y - 25

    draw_text(
        x,
        y,
        "ALT",
        COLORS.gray
    )

    draw_text(
        x + 100,
        y,
        fmt(xt_altitude_ft) .. " FT",
        COLORS.white
    )

    draw_text(
        x + 250,
        y,
        "IAS",
        COLORS.gray
    )

    draw_text(
        x + 325,
        y,
        fmt(xt_ias_kts) .. " KT",
        COLORS.white
    )

    y = y - 25

    draw_text(
        x,
        y,
        "HDG",
        COLORS.gray
    )

    draw_text(
        x + 100,
        y,
        fmt(xt_heading) .. "°",
        COLORS.white
    )

    draw_text(
        x + 250,
        y,
        "VS",
        COLORS.gray
    )

    draw_text(
        x + 325,
        y,
        fmt(xt_vs_fpm) .. " FPM",
        COLORS.white
    )

    y = y - 25

    draw_text(
        x,
        y,
        "PITCH",
        COLORS.gray
    )

    draw_text(
        x + 100,
        y,
        fmt(xt_pitch, 1) .. "°",
        COLORS.white
    )

    draw_text(
        x + 250,
        y,
        "ROLL",
        COLORS.gray
    )

    draw_text(
        x + 325,
        y,
        fmt(xt_roll, 1) .. "°",
        COLORS.white
    )

    y = y - 25

    draw_text(
        x,
        y,
        "AOA",
        COLORS.gray
    )

    draw_text(
        x + 100,
        y,
        fmt(xt_aoa, 1) .. "°",
        COLORS.white
    )

    draw_text(
        x + 250,
        y,
        "GS",
        COLORS.gray
    )

    draw_text(
        x + 325,
        y,
        fmt(xt_groundspeed_kts) .. " KT",
        COLORS.white
    )

    y = y - 28

    draw_line(
        x,
        y + 10,
        x + CFG.tablet_w - 40,
        y + 10,
        COLORS.border
    )

    y = y - 12

    local ap = get_ap_text()

    draw_text(
        x,
        y,
        "AUTOPILOT",
        COLORS.gray
    )

    draw_text(
        x + 100,
        y,
        ap,
        ap == "OFF" and COLORS.yellow or COLORS.green
    )

    y = y - 24

    draw_text(
        x,
        y,
        "AP ALT",
        COLORS.gray
    )

    draw_text(
        x + 100,
        y,
        fmt(xt_ap_altitude) .. " FT",
        COLORS.white
    )

    y = y - 24

    draw_text(
        x,
        y,
        "AP HDG",
        COLORS.gray
    )

    draw_text(
        x + 100,
        y,
        fmt(xt_ap_heading, 0) .. "°",
        COLORS.white
    )

    y = y - 24

    draw_text(
        x,
        y,
        "AP VS",
        COLORS.gray
    )

    draw_text(
        x + 100,
        y,
        fmt(xt_ap_vs) .. " FPM",
        COLORS.white
    )

    y = y - 30

    local msg = assistant_message()

    draw_text(
        x,
        y,
        msg,
        STATE.warning_level >= 3
            and COLORS.red
            or STATE.warning_level == 2
            and COLORS.orange
            or STATE.warning_level == 1
            and COLORS.yellow
            or COLORS.green
    )
end

------------------------------------------------------------
-- PAGE 2: ARMS
------------------------------------------------------------

local function draw_arms()

    local x = CFG.tablet_x + 20
    local y = CFG.tablet_y + CFG.tablet_h - 70

    draw_text(
        x,
        y,
        "ARMS SAFETY MONITOR",
        COLORS.white
    )

    y = y - 28

    draw_text(
        x,
        y,
        "SYSTEM",
        COLORS.gray
    )

    draw_text(
        x + 100,
        y,
        CFG.arms_enabled and "ACTIVE" or "STANDBY",
        CFG.arms_enabled and COLORS.green or COLORS.yellow
    )

    y = y - 25

    draw_text(
        x,
        y,
        "RISK",
        COLORS.gray
    )

    local risk_text = "NORMAL"
    local risk_color = COLORS.green

    if STATE.risk_level == 1 then
        risk_text = "ADVISORY"
        risk_color = COLORS.yellow
    elseif STATE.risk_level == 2 then
        risk_text = "WARNING"
        risk_color = COLORS.orange
    elseif STATE.risk_level >= 3 then
        risk_text = "CRITICAL"
        risk_color = COLORS.red
    end

    draw_text(
        x + 100,
        y,
        risk_text,
        risk_color
    )

    y = y - 28

    draw_text(
        x,
        y,
        "PITCH",
        COLORS.gray
    )

    draw_text(
        x + 100,
        y,
        fmt(xt_pitch, 1) .. "°",
        COLORS.white
    )

    y = y - 23

    draw_text(
        x,
        y,
        "ROLL",
        COLORS.gray
    )

    draw_text(
        x + 100,
        y,
        fmt(xt_roll, 1) .. "°",
        COLORS.white
    )

    y = y - 23

    draw_text(
        x,
        y,
        "AOA",
        COLORS.gray
    )

    draw_text(
        x + 100,
        y,
        fmt(xt_aoa, 1) .. "°",
        COLORS.white
    )

    y = y - 23

    draw_text(
        x,
        y,
        "VS",
        COLORS.gray
    )

    draw_text(
        x + 100,
        y,
        fmt(xt_vs_fpm) .. " FPM",
        COLORS.white
    )

    y = y - 28

    local p_ias, p_alt, p_vs =
        predicted_values()

    draw_text(
        x,
        y,
        "5 SEC PREDICTION",
        COLORS.cyan
    )

    y = y - 23

    draw_text(
        x,
        y,
        "IAS",
        COLORS.gray
    )

    draw_text(
        x + 100,
        y,
        fmt(p_ias, 0) .. " KT",
        COLORS.white
    )

    y = y - 23

    draw_text(
        x,
        y,
        "ALT",
        COLORS.gray
    )

    draw_text(
        x + 100,
        y,
        fmt(p_alt, 0) .. " FT",
        COLORS.white
    )

    y = y - 23

    draw_text(
        x,
        y,
        "VS",
        COLORS.gray
    )

    draw_text(
        x + 100,
        y,
        fmt(p_vs, 0) .. " FPM",
        COLORS.white
    )

    y = y - 32

    if STATE.warning ~= "" then

        draw_rect(
            x,
            y - 8,
            x + CFG.tablet_w - 40,
            y + 28,
            STATE.warning_level >= 3
                and COLORS.red
                or STATE.warning_level == 2
                and COLORS.orange
                or COLORS.yellow
        )

        draw_text(
            x + 12,
            y + 5,
            STATE.warning,
            COLORS.white
        )

    else

        draw_text(
            x,
            y,
            "NO ACTIVE WARNING",
            COLORS.green
        )

    end
end

------------------------------------------------------------
-- PAGE 3: CHECKLIST
------------------------------------------------------------

local function draw_checklist()

    local c = current_checklist()

    if not c then
        return
    end

    local x = CFG.tablet_x + 20
    local y = CFG.tablet_y + CFG.tablet_h - 70

    draw_text(
        x,
        y,
        "CHECKLIST",
        COLORS.white
    )

    draw_text(
        x + 180,
        y,
        c.name,
        COLORS.cyan
    )

    y = y - 28

    local first = math.max(
        1,
        STATE.checklist_item - 5
    )

    local last = math.min(
        #c.items,
        first + 7
    )

    for i = first, last do

        local checked =
            is_item_checked(i)

        local prefix =
            checked and "[✓] " or "[ ] "

        local ccol =
            checked and COLORS.green or COLORS.white

        draw_text(
            x,
            y,
            prefix .. c.items[i],
            ccol
        )

        if i == STATE.checklist_item then

            draw_text(
                x + 360,
                y,
                "<",
                COLORS.cyan
            )

        end

        y = y - 25
    end

    y = CFG.tablet_y + 45

    draw_line(
        x,
        y + 12,
        x + CFG.tablet_w - 40,
        y + 12,
        COLORS.border
    )

    draw_text(
        x,
        y - 3,
        "NEXT ITEM: " ..
        tostring(
            math.min(
                STATE.checklist_item,
                #c.items
            )
        ) ..
        "/" ..
        tostring(#c.items),
        COLORS.cyan
    )
end

------------------------------------------------------------
-- PAGE 4: AP / NAV
------------------------------------------------------------

local function draw_navigation()

    local x = CFG.tablet_x + 20
    local y = CFG.tablet_y + CFG.tablet_h - 70

    draw_text(
        x,
        y,
        "NAVIGATION / AP",
        COLORS.white
    )

    y = y - 30

    draw_text(
        x,
        y,
        "AP STATUS",
        COLORS.gray
    )

    draw_text(
        x + 120,
        y,
        get_ap_text(),
        COLORS.green
    )

    y = y - 24

    draw_text(
        x,
        y,
        "ADVICE",
        COLORS.gray
    )

    y = y - 22

    draw_text(
        x,
        y,
        get_ap_advice(),
        COLORS.cyan
    )

    y = y - 35

    draw_text(
        x,
        y,
        "TARGET ALT",
        COLORS.gray
    )

    draw_text(
        x + 120,
        y,
        fmt(xt_ap_altitude) .. " FT",
        COLORS.white
    )

    y = y - 24

    draw_text(
        x,
        y,
        "TARGET HDG",
        COLORS.gray
    )

    draw_text(
        x + 120,
        y,
        fmt(xt_ap_heading) .. "°",
        COLORS.white
    )

    y = y - 24

    draw_text(
        x,
        y,
        "TARGET VS",
        COLORS.gray
    )

    draw_text(
        x + 120,
        y,
        fmt(xt_ap_vs) .. " FPM",
        COLORS.white
    )

    y = y - 36

    draw_text(
        x,
        y,
        "NAV1",
        COLORS.gray
    )

    draw_text(
        x + 120,
        y,
        fmt((xt_nav1_freq or 0) / 10000, 2),
        COLORS.white
    )

    y = y - 24

    draw_text(
        x,
        y,
        "NAV2",
        COLORS.gray
    )

    draw_text(
        x + 120,
        y,
        fmt((xt_nav2_freq or 0) / 10000, 2),
        COLORS.white
    )

    y = y - 32

    draw_text(
        x,
        y,
        "NOTE:",
        COLORS.yellow
    )

    y = y - 22

    draw_text(
        x,
        y,
        "Route guidance remains aircraft/FMS dependent.",
        COLORS.gray
    )
end

------------------------------------------------------------
-- PAGE 5: SYSTEM LOG
------------------------------------------------------------

local function draw_log()

    local x = CFG.tablet_x + 20
    local y = CFG.tablet_y + CFG.tablet_h - 70

    draw_text(
        x,
        y,
        "EVENT LOG",
        COLORS.white
    )

    y = y - 28

    local count = math.min(
        #STATE.event_log,
        9
    )

    for i = 1, count do

        local e = STATE.event_log[i]

        draw_text(
            x,
            y,
            "[" .. e.time .. "]",
            COLORS.dim
        )

        draw_text(
            x + 85,
            y,
            e.text,
            COLORS.white
        )

        y = y - 25
    end
end

------------------------------------------------------------
-- FOOTER
------------------------------------------------------------

local function draw_footer()

    local x = CFG.tablet_x + 20
    local y = CFG.tablet_y + 20

    draw_text(
        x,
        y,
        "PAGE " .. tostring(STATE.page) .. "/5",
        COLORS.gray
    )

    draw_text(
        x + 100,
        y,
        "NEXT",
        COLORS.cyan
    )

    draw_text(
        x + 165,
        y,
        "PREV",
        COLORS.cyan
    )

    draw_text(
        x + 245,
        y,
        "CHK",
        COLORS.cyan
    )

    draw_text(
        x + 315,
        y,
        "ARMS",
        COLORS.cyan
    )
end

------------------------------------------------------------
-- MAIN DRAW
------------------------------------------------------------

function xt_draw()

    if not CFG.enabled then
        return
    end

    if not CFG.tablet_visible then
        return
    end

    draw_tablet_frame()

    if STATE.page == 1 then
        draw_overview()
    elseif STATE.page == 2 then
        draw_arms()
    elseif STATE.page == 3 then
        draw_checklist()
    elseif STATE.page == 4 then
        draw_navigation()
    elseif STATE.page == 5 then
        draw_log()
    end

    draw_footer()
end

------------------------------------------------------------
-- TOP WARNING BANNER
------------------------------------------------------------

local function draw_warning_banner()

    if not CFG.warnings_enabled then
        return
    end

    if STATE.muted then
        return
    end

    if STATE.warning == "" then
        return
    end

    if STATE.warning_level <= 0 then
        return
    end

    local w = 570
    local x = 40
    local y = 720

    local c =
        STATE.warning_level >= 3
        and COLORS.red
        or STATE.warning_level == 2
        and COLORS.orange
        or COLORS.yellow

    draw_rect(
        x,
        y,
        x + w,
        y + 38,
        c
    )

    draw_text(
        x + 14,
        y + 12,
        STATE.warning,
        COLORS.white
    )
end

------------------------------------------------------------
-- MASTER DRAW
------------------------------------------------------------

function xt_master_draw()

    draw_warning_banner()
    xt_draw()
end

do_every_draw("xt_master_draw()")

------------------------------------------------------------
-- PERIODIC UPDATE
------------------------------------------------------------

local function update_core()

    if not CFG.enabled then
        return
    end

    local now = os.clock()

    local dt =
        now - STATE.last_update

    if dt <= 0 then
        return
    end

    STATE.last_update = now

    if dt > 1.0 then
        dt = 0.1
    end

    STATE.flight_time =
        STATE.flight_time + dt

    --------------------------------------------------------
    -- TRENDS
    --------------------------------------------------------

    update_trends(dt)

    --------------------------------------------------------
    -- PHASE
    --------------------------------------------------------

    local new_phase =
        detect_phase()

    if new_phase ~= STATE.last_phase then

        add_log(
            "Phase: " ..
            STATE.last_phase ..
            " -> " ..
            new_phase
        )

        STATE.last_phase =
            new_phase

        select_checklist_for_phase(
            new_phase
        )
    end

    --------------------------------------------------------
    -- RISK
    --------------------------------------------------------

    if CFG.arms_enabled then
        run_risk_engine()
    end

    --------------------------------------------------------
    -- WARNING TIMER
    --------------------------------------------------------

    reset_warning()

    --------------------------------------------------------
    -- LOG AP CHANGES
    --------------------------------------------------------

    local ap_now = xt_ap_mode or 0

    if ap_now ~= STATE.ap_latched then

        STATE.ap_latched = ap_now

        add_log(
            "AP state changed: " ..
            get_ap_text()
        )
    end
end

do_often("update_core()", 0.1)

------------------------------------------------------------
-- COMMANDS
------------------------------------------------------------

create_command(
    "x_tablet/toggle",
    "X-Tablet: Toggle tablet",
    "CFG.tablet_visible = not CFG.tablet_visible",
    "",
    ""
)

create_command(
    "x_tablet/next_page",
    "X-Tablet: Next page",
    "STATE.page = STATE.page + 1\n" ..
    "if STATE.page > 5 then STATE.page = 1 end",
    "",
    ""
)

create_command(
    "x_tablet/previous_page",
    "X-Tablet: Previous page",
    "STATE.page = STATE.page - 1\n" ..
    "if STATE.page < 1 then STATE.page = 5 end",
    "",
    ""
)

create_command(
    "x_tablet/next_checklist",
    "X-Tablet: Next checklist",
    "next_checklist()",
    "",
    ""
)

create_command(
    "x_tablet/check_item",
    "X-Tablet: Check current item",
    "check_current_item()",
    "",
    ""
)

create_command(
    "x_tablet/reset_checklist",
    "X-Tablet: Reset checklist",
    "reset_current_checklist()",
    "",
    ""
)

create_command(
    "x_tablet/mute_warnings",
    "X-Tablet: Mute warning banner",
    "STATE.muted = not STATE.muted",
    "",
    ""
)

create_command(
    "x_tablet/arms_toggle",
    "X-Tablet: Toggle ARMS monitor",
    "CFG.arms_enabled = not CFG.arms_enabled\n" ..
    "add_log('ARMS ' .. (CFG.arms_enabled and 'ENABLED' or 'DISABLED'))",
    "",
    ""
)

create_command(
    "x_tablet/assistant_toggle",
    "X-Tablet: Toggle assistant",
    "CFG.assistant_enabled = not CFG.assistant_enabled\n" ..
    "add_log('Assistant ' .. (CFG.assistant_enabled and 'ENABLED' or 'DISABLED'))",
    "",
    ""
)

create_command(
    "x_tablet/log_event",
    "X-Tablet: Add event to log",
    "add_log('Pilot event')",
    "",
    ""
)

------------------------------------------------------------
-- RESET STATE WHEN SCRIPT STARTS
------------------------------------------------------------

local function init()

    STATE.last_phase =
        detect_phase()

    STATE.last_update =
        os.clock()

    STATE.airspeed_prev =
        xt_ias_kts or 0

    STATE.altitude_prev =
        xt_altitude_ft or 0

    STATE.vs_prev =
        xt_vs_fpm or 0

    add_log(
        "X-Tablet Flight Core initialized"
    )

    add_log(
        "Initial phase: " ..
        STATE.last_phase
    )

    STATE.initialized = true
end

init()

------------------------------------------------------------
-- OPTIONAL DEFAULT PAGE
------------------------------------------------------------

STATE.page = 1

------------------------------------------------------------
-- END
------------------------------------------------------------
