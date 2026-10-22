import type { AdbExecuteOptions } from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { ExecResult } from "../../src/models";
import { createExecResult } from "../../src/utils/execResult";
import { FakeAdbExecutor } from "./FakeAdbExecutor";

/** A small emulator power model behind the `FakeAdbExecutor` seam: commands change state, dumps read it. */
export class FakePowerAdb extends FakeAdbExecutor {
  battery = { level: 100, ac: true, usb: false, wireless: false, status: 2, stopped: false };
  deepEnabled = true;
  lightEnabled = true;
  deep = "ACTIVE";
  light = "ACTIVE";
  lowPower: string = "null";
  restrictBackground = false;
  thermal = { override: false, status: 0 };
  buckets = new Map<string, number>();
  inactive = new Map<string, boolean>();
  /** Android switches battery saver off while a charger is connected (as BatterySaverStateMachine does). */
  saverOffWhileCharging = false;
  /** Commands (joined argv) containing any of these substrings fail with a device error. */
  failing = new Set<string>();
  /** Keep a command failing only this many more times (default: forever). */
  failTimes = new Map<string, number>();

  override async execute(args: string[], options: AdbExecuteOptions = {}): Promise<ExecResult> {
    await super.execute(args, options);
    const command = args.join(" ");
    for (const pattern of this.failing) {
      if (command.includes(pattern)) {
        const left = this.failTimes.get(pattern);
        if (left === undefined || left > 0) {
          if (left !== undefined) {
            this.failTimes.set(pattern, left - 1);
          }
          return createExecResult(`Exception: simulated failure of ${pattern}\n`, "");
        }
      }
    }
    return createExecResult(this.run(args.slice(1)), "");
  }

  private run(args: string[]): string {
    const [cmd, sub, ...rest] = args;
    if (cmd === "dumpsys" && sub === "battery") {
      return this.runBattery(rest);
    }
    if (cmd === "dumpsys" && sub === "deviceidle") {
      return this.runDeviceIdle(rest);
    }
    if (cmd === "dumpsys" && sub === "thermalservice") {
      return `IsStatusOverride: ${this.thermal.override}\nThermal Status: ${this.thermal.status}\n`;
    }
    if (cmd === "settings") {
      return this.runSettings(sub, rest);
    }
    if (cmd === "cmd") {
      return this.runCmd(sub, rest);
    }
    if (cmd === "am") {
      return this.runAm(sub, rest);
    }
    if (cmd === "input" && rest[0] === "KEYCODE_SLEEP") {
      this.setScreenState(false);
    }
    if (cmd === "input" && rest[0] === "KEYCODE_WAKEUP") {
      this.setScreenState(true);
    }
    return "";
  }

  private runBattery(rest: string[]): string {
    const b = this.battery;
    if (rest[0] === "reset") {
      this.battery = {
        level: 100,
        ac: true,
        usb: false,
        wireless: false,
        status: 2,
        stopped: false,
      };
    } else if (rest[0] === "unplug") {
      Object.assign(b, { ac: false, usb: false, wireless: false, stopped: true });
    } else if (rest[0] === "set") {
      b.stopped = true;
      const value = Number(rest[2]);
      if (rest[1] === "level") {
        b.level = value;
      }
      if (rest[1] === "status") {
        b.status = value;
      }
      if (rest[1] === "ac") {
        b.ac = value === 1;
      }
      if (rest[1] === "usb") {
        b.usb = value === 1;
      }
      if (rest[1] === "wireless") {
        b.wireless = value === 1;
      }
    } else {
      return (
        "Current Battery Service state:\n" +
        (b.stopped ? "  (UPDATES STOPPED -- use 'reset' to restart)\n" : "") +
        `  AC powered: ${b.ac}\n  USB powered: ${b.usb}\n  Wireless powered: ${b.wireless}\n` +
        `  status: ${b.status}\n  health: 2\n  present: true\n  level: ${b.level}\n  scale: 100\n`
      );
    }
    return "";
  }

  private runDeviceIdle(rest: string[]): string {
    const kind = rest[1] === "light" ? "light" : "deep";
    if (rest[0] === "enabled") {
      return `${(kind === "deep" ? this.deepEnabled : this.lightEnabled) ? 1 : 0}\n`;
    }
    if (rest[0] === "get") {
      return `${kind === "deep" ? this.deep : this.light}\n`;
    }
    if (rest[0] === "force-idle") {
      if (!(kind === "deep" ? this.deepEnabled : this.lightEnabled)) {
        return "Unable to go idle; not enabled\n";
      }
      if (kind === "deep") {
        this.deep = "IDLE";
      } else {
        this.light = "IDLE";
      }
      return `Now forced in to ${kind} idle mode\n`;
    }
    if (rest[0] === "unforce") {
      this.deep = "ACTIVE";
      this.light = "ACTIVE";
    }
    return "";
  }

  private runSettings(sub: string | undefined, rest: string[]): string {
    if (sub === "get") {
      return `${this.lowPower}\n`;
    }
    if (sub === "put") {
      const charging = this.battery.ac || this.battery.usb || this.battery.wireless;
      this.lowPower = this.saverOffWhileCharging && charging ? "0" : (rest[2] ?? "0");
    }
    return "";
  }

  private runCmd(service: string | undefined, rest: string[]): string {
    if (service === "netpolicy") {
      if (rest[0] === "set") {
        this.restrictBackground = rest[2] === "true";
      }
      return rest[0] === "get"
        ? `Restrict background status: ${this.restrictBackground ? "enabled" : "disabled"}\n`
        : "";
    }
    if (rest[0] === "override-status") {
      this.thermal = { override: true, status: Number(rest[1]) };
    }
    if (rest[0] === "reset") {
      this.thermal = { override: false, status: 0 };
    }
    return "";
  }

  private runAm(sub: string | undefined, rest: string[]): string {
    const [app = "", value = ""] = rest;
    const names: Record<string, number> = {
      active: 10,
      working_set: 20,
      frequent: 30,
      rare: 40,
      restricted: 45,
    };
    if (sub === "get-standby-bucket") {
      return `${this.buckets.get(app) ?? 10}\n`;
    }
    if (sub === "set-standby-bucket") {
      this.buckets.set(app, names[value] ?? 10);
    }
    if (sub === "get-inactive") {
      return `Idle=${this.inactive.get(app) ?? false}\n`;
    }
    if (sub === "set-inactive") {
      this.inactive.set(app, value === "true");
    }
    return "";
  }
}
