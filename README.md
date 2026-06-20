# Low-Cost Solar Micro-Mining Optimization Control
### Nerd-Class Automation for ESP32/Lilygo Arrays via Shelly EM

An open-source, highly efficient, and budget-friendly power management script written in JavaScript (mJS) for Shelly Gen2/Gen3 devices. 

This project is specifically designed for the **Nerd-Class open-hardware community** utilizing micro-miners (like Lilygo T-Display/AxeOS setups) and solar energy.



## 🚀 Overview & Architecture
Instead of using heavy, expensive hardware or pre-baked complex software stacks, this script runs natively on a single **Shelly** device to track solar surplus and orchestrate load balancing using two independent layers of control:
1. **Physical Power Layer (Hardware):** Controls the relays feeding the Lilygo micro-controllers.
2. **Logical Production Layer (Software API):** Interrogates the miner's internal state via HTTP REST API to toggle the ASIC chips between maximum performance and low-power standby (2W).

## 🛠️ Features
- **Closed-Loop Telemetry:** Dynamically checks the real ASIC status before making decisions.
- **Low-Voltage Hardware Protection:** Prevents mechanical relay wear by toggling states via software API during the day.
- **Low-Cost Buffer Safety:** Employs a Moving Average filter, safety margins (offsets), and a deadtime blocking window (moratorium) to prevent rapid on/off switching ("chattering").
- **Strict Night Cleanup:** Automatically cuts off physical standby power at night and pre-charges controllers at dawn.
