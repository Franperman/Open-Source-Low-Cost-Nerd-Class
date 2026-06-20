// ============================================================================
// 1. SYSTEM CONFIGURATION (Change these values to match your home setup)
// ============================================================================

// Safety power buffer in Watts (Surplus must exceed miner consumption + this buffer)
let POWER_BUFFER = 60;

// Execution interval for the main loop in seconds
let CHECK_INTERVAL_SEC = 15;

// Moving Average Filter: Number of power samples to calculate stability
let MAX_SAMPLES = 15;
let powerSamples = [];

// Deadtime Window (Moratorium): Number of cycles to freeze actions after toggling a load
let MORATORIA_CYCLES = 8;
let moratoriaCounter = 0;

let rotationIndex = 0;
let currentCycle = 0;
let lastRegisteredHour = -1;

// ============================================================================
// 2. HARDWARE MATRIX (Map your Shelly Relays and Miner IPs here)
// ============================================================================
let devices = [
  { name: "NerdOctaxe 1", plugIp: "192.168.50.67", plugId: "1", minerIp: "192.168.50.248", consumption: 215, plugOn: false, mining: false, turnedOnAt: -1 },
  { name: "Nerdqaxe 1",   plugIp: "192.168.50.67", plugId: "2", minerIp: "192.168.50.130", consumption: 85,  plugOn: false, mining: false, turnedOnAt: -1 },
  { name: "Nerdqaxe 2",   plugIp: "192.168.50.67", plugId: "3", minerIp: "192.168.50.164", consumption: 85,  plugOn: false, mining: false, turnedOnAt: -1 }
];

// Water Heater configuration (High Priority load)
let waterHeater = { name: "Water Heater", ip: "192.168.50.159", id: "0", status: false };
let HEATER_THRESHOLD_W = 1600;

// ============================================================================
// 3. NETWORK NETWORK HELPERS (Asynchronous HTTP abstraction layer)
// ============================================================================

// Toggles physical power on a remote Shelly relay
function setRemotePlug(ip, id, turnOn, callback) {
  let action = turnOn ? "true" : "false";
  let url = "http://" + ip + "/rpc/switch.set?id=" + id + "&on=" + action;
  Shelly.call("HTTP.GET", { url: url }, function(res, err_code) { 
    if (callback) callback(err_code === 0); 
  });
}

// Fetches the real physical state of a remote Shelly relay
function getRemotePlugState(ip, id, callback) {
  let url = "http://" + ip + "/rpc/Switch.GetStatus?id=" + id;
  Shelly.call("HTTP.GET", { url: url }, function(res, err_code) {
    if (err_code === 0 && res && res.code === 200 && res.body) {
      callback(JSON.parse(res.body).output === true);
    } else {
      callback(null);
    }
  });
}

// Sends API commands to the miner's AxeOS firmware system endpoint
function contactMinerAPI(ip, endpointAction, callback) {
  let url = "http://" + ip + "/api/system/" + endpointAction;
  let body = endpointAction === "shutdown" ? '{"shutdown":true}' : "{}";
  Shelly.call("HTTP.Request", { method: "POST", url: url, body: body }, function(res, err_code) {
    if (callback) callback(err_code === 0);
  });
}

// Closed-loop validation: Fetches real mining status from the ASIC control board
function checkRealMinerMining(ip, callback) {
  let url = "http://" + ip + "/api/system/info";
  Shelly.call("HTTP.GET", { url: url }, function(res, err_code) {
    if (err_code === 0 && res && res.code === 200 && res.body) {
      let data = JSON.parse(res.body);
      callback(data.shutdown === false); // Returns true if ASICs are computing hashes
    } else {
      callback(null); // Offline or booting up
    }
  });
}

// ============================================================================
// 4. LOAD MANAGEMENT SEARCH LOGIC (Rotational balancing algorithms)
// ============================================================================

// Locates the next miner available to boot up
function getNextDeviceToStart() {
  let n = devices.length;
  for (let i = 0; i < n; i++) {
    let idx = (rotationIndex + i) % n;
    if (!devices[idx].mining) return idx;
  }
  return -1;
}

// Locates the oldest active miner to turn off (FIFO queue)
function getNextDeviceToStop() {
  let candidate = -1;
  let oldestCycle = -1;
  for (let i = 0; i < devices.length; i++) {
    if (devices[i].mining) {
      if (candidate === -1 || devices[i].turnedOnAt < oldestCycle) {
        candidate = i;
        oldestCycle = devices[i].turnedOnAt;
      }
    }
  }
  return candidate;
}

// Compiles a visual string of current matrix parameters
function compileTelemetryLog() {
  let txt = "";
  for (let i = 0; i < devices.length; i++) {
    txt += devices[i].name + "[Relay:" + (devices[i].plugOn ? "ON" : "OFF") + "|ASIC:" + (devices[i].mining ? "MINING" : "IDLE") + "] ";
  }
  return txt + waterHeater.name + ":" + (waterHeater.status ? "ON" : "OFF");
}

// ============================================================================
// 5. EXECUTION ENGINE (Sequential control loops)
// ============================================================================

// Sequentially handles the safe boot sequence of a miner channel
function startDeviceSequence(idx) {
  let dev = devices[idx];
  setRemotePlug(dev.plugIp, dev.plugId, true, function(success) {
    if (!success) return;
    devices[idx].plugOn = true;
    
    // Warm reboot forces AxeOS to safely initialize components cleanly
    contactMinerAPI(dev.mineroIp, "restart", function(apiSuccess) {
      if (!apiSuccess) { print("X API initialization error on " + dev.name); return; }
      print("-> " + dev.name + " BOOT SEQUENCE COMPLETED");
      devices[idx].mining = true;
      devices[idx].turnedOnAt = currentCycle;
      rotationIndex = (rotationIndex + 1) % devices.length;
    });
  });
  moratoriaCounter = MORATORIA_CYCLES;
}

// Sequentially handles the shutdown or diurn standby sequence
function stopDeviceSequence(idx, isNightTime) {
  let dev = devices[idx];
  contactMinerAPI(dev.mineroIp, "shutdown", function(success) {
    if (!success) print("X Miner API unreachable on " + dev.minerIp + " (Expected if unpowered)");
    devices[idx].mining = false;
    devices[idx].turnedOnAt = -1;

    // Day: Keep power ON for standby telemetry. Night: Cut physical relay completely.
    let keepPowerRelayOn = !isNightTime; 
    setRemotePlug(dev.plugIp, dev.plugId, keepPowerRelayOn, function(relaySuccess) {
      if (relaySuccess) {
        devices[idx].plugOn = keepPowerRelayOn;
        print("-> " + dev.name + (isNightTime ? " HARDWARE DISCONNECTED (Night Safe)" : " STANDBY MODE ACTIVATED (Day Cloud)"));
      }
    });
  });
  moratoriaCounter = MORATORIA_CYCLES;
}

function updateWaterHeater(turnOn) {
  setRemotePlug(waterHeater.ip, waterHeater.id, turnOn, function(success) { 
    if (success) waterHeater.status = turnOn; 
  });
}

// ============================================================================
// 6. INITIALIZATION & CALIBRATION (Fires only once upon script launch)
// ============================================================================
function calibrateInitialStates() {
  print("=== INITIALIZING CLOSED-LOOP BARRIDO ===");
  
  getRemotePlugState(waterHeater.ip, waterHeater.id, function(state) {
    if (state !== null) { waterHeater.status = state; print("✓ " + waterHeater.name + " state verified: " + (state ? "ON" : "OFF")); }
  });

  for (let i = 0; i < devices.length; i++) {
    let currentIdx = i;
    getRemotePlugState(devices[currentIdx].plugIp, devices[currentIdx].plugId, function(relayState) {
      if (relayState === null) return;
      devices[currentIdx].plugOn = relayState;

      if (!relayState) {
        devices[currentIdx].mining = false;
        devices[currentIdx].turnedOnAt = -1;
        print("✓ " + devices[currentIdx].name + " -> Relay is OFF, system IDLE");
      } else {
        // Closed-loop verification: Ask the chip if it was already producing hashes
        checkRealMinerMining(devices[currentIdx].mineroIp, function(realMiningState) {
          if (realMiningState === true) {
            devices[currentIdx].mining = true;
            devices[currentIdx].turnedOnAt = 0;
            print("✓ " + devices[currentIdx].name + " -> Validated: MINING actively. Left untouched.");
          } else {
            devices[currentIdx].mining = false;
            print("✓ " + devices[currentIdx].name + " -> Validated: Power is ON but ASICs IDLE.");
          }
        });
      }
    });
  }
}
calibrateInitialStates();

// ============================================================================
// 7. TIME HORIZON TRANSITIONS (07:00 / 21:00 Strict Gates)
// ============================================================================
function enforceTimeTransitionGates(hour) {
  if (hour === 21) {
    print("🌙 [21:00 GATING] Initiating absolute night physical power cut...");
    for (let i = 0; i < devices.length; i++) {
      setRemotePlug(devices[i].plugIp, devices[i].plugId, false);
      devices[i].plugOn = false;
      devices[i].mining = false;
      devices[i].turnedOnAt = -1;
    }
  }
  if (hour === 7) {
    print("☀️ [07:00 GATING] Charging physical rails for upcoming solar day...");
    for (let i = 0; i < devices.length; i++) {
      setRemotePlug(devices[i].plugIp, devices[i].plugId, true);
      devices[i].plugOn = true;
    }
    moratoriaCounter = MORATORIA_CYCLES; // Give controllers time to establish Wi-Fi
  }
}

// ============================================================================
// 8. CRITICAL MAIN TIMER LOOP
// ============================================================================
Timer.set(CHECK_INTERVAL_SEC * 1000, true, function() {
  currentCycle++;

  Shelly.call("Sys.GetStatus", {}, function(sysRes) {
    if (!sysRes || !sysRes.time) return;

    let timeArray = sysRes.time.split(":");
    let hour = timeArray[0] * 1;
    let isNightTime = (hour >= 21 || hour < 7);

    if (timeArray[0] === "00" && currentCycle > 100) {
      currentCycle = 0; powerSamples = []; print("=== MAIN RESYNC: NEW DAY ===");
    }

    if (hour !== lastRegisteredHour) {
      enforceTimeTransitionGates(hour);
      lastRegisteredHour = hour;
    }

    Shelly.call("Shelly.GetStatus", {}, function(meterRes, error) {
      if (error !== 0 || !meterRes) return;

      // Channel 0 tracks grid net consumption (injected back as negative for surplus math)
      let currentGridPower = meterRes["em1:1"].act_power;
      let currentHeaterPower = meterRes["em1:1"].act_power;

      // Apply Low-Pass Filter (Moving Average)
      if (powerSamples.length >= MAX_SAMPLES) powerSamples.splice(0, 1);
      powerSamples.push(currentGridPower);

      let totalSum = 0;
      for (let i = 0; i < powerSamples.length; i++) totalSum += powerSamples[i];
      let averagedSurplus = totalSum / powerSamples.length;

      print("Cycle " + currentCycle + " | Grid: " + currentGridPower + "W | Avg Surplus: " + Math.round(averagedSurplus) + "W | " + compileTelemetryLog());

      // WATER HEATER SURPLUS LOGIC
      if (!waterHeater.status && currentHeaterPower <= -HEATER_THRESHOLD_W) {
        print("🔥 HIGH SURPLUS CRITERIA -> Launching Water Heater");
        updateWaterHeater(true);
      } else if (waterHeater.status && currentHeaterPower > 10) {
        print("⚠️ LOW GENERATION -> Stopping Water Heater");
        updateWaterHeater(false);
      }

      // Check temporal moratorium block constraints
      if (moratoriaCounter > 0) { moratoriaCounter--; return; }

      // STRATEX: BOOT LAYER
      let idxOn = getNextDeviceToStart();
      if (idxOn !== -1 && averagedSurplus <= -(devices[idxOn].consumption + POWER_BUFFER)) {
        print("☀️ SURPLUS DETECTED -> Booting up " + devices[idxOn].name);
        startDeviceSequence(idxOn);
        return;
      }

      // STRATEX: SHUTDOWN LAYER
      if (averagedSurplus > -8) {
        let idxOff = getNextDeviceToStop();
        if (idxOff !== -1) {
          print("☁️ NUBE/LOW GENERATION -> Shedding load on " + devices[idxOff].name);
          stopDeviceSequence(idxOff, isNightTime);
          return;
        }
        
        // Strict safety net: Enforce physical off execution window at night
        if (isNightTime) {
          for (let k = 0; k < devices.length; k++) {
            if (devices[k].plugOn) {
              setRemotePlug(devices[k].plugIp, devices[k].plugId, false);
              devices[k].plugOn = false;
            }
          }
        }
      }
    });
  });
});