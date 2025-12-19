import * as fs from "fs";
import * as path from "path";

class ProcessLogger {
  private logStream: fs.WriteStream | null = null;
  private logFilePath: string | undefined;
  private enabled: boolean;

  constructor(logDir: string = "./logs", enabled: boolean = true) {
    this.enabled = enabled;
    if (!this.enabled) {
      return;
    }

    // Synchronous filesystem operations are intentional here for initialization simplicity.
    // This logger is created once at startup, so the brief blocking is acceptable.
    fs.mkdirSync(logDir, { recursive: true });

    // Create log file with timestamp
    const timestamp = new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "");
    this.logFilePath = path.join(logDir, `process-${timestamp}.log`);

    // Create write stream
    this.logStream = fs.createWriteStream(this.logFilePath, { flags: "a" });

    // Handle stream errors to prevent unhandled exceptions
    this.logStream.on("error", (err) => {
      console.error(`[ProcessLogger] Write stream error: ${err.message}`);
      this.logStream = null;
    });

    this.log("INFO", "Process logger initialized");
    this.log("INFO", `Log file: ${this.logFilePath}`);
    this.log("INFO", "=".repeat(80));
  }

  private formatMessage(level: string, component: string, message: string, data?: any): string {
    const timestamp = new Date().toISOString();
    let logMessage = `[${timestamp}] [${level}] [${component}] ${message}`;

    if (data !== undefined) {
      if (Buffer.isBuffer(data)) {
        logMessage += ` | Buffer(${data.length} bytes)`;
      } else if (typeof data === "object") {
        logMessage += ` | ${JSON.stringify(data)}`;
      } else {
        logMessage += ` | ${data}`;
      }
    }

    return logMessage;
  }

  public log(level: string, message: string, component: string = "System", data?: any): void {
    if (!this.enabled || !this.logStream) {
      return;
    }

    const formattedMessage = this.formatMessage(level, component, message, data);
    this.logStream.write(formattedMessage + "\n");
  }

  public info(message: string, component: string = "System", data?: any): void {
    this.log("INFO", message, component, data);
  }

  public debug(message: string, component: string = "System", data?: any): void {
    this.log("DEBUG", message, component, data);
  }

  public warn(message: string, component: string = "System", data?: any): void {
    this.log("WARN", message, component, data);
  }

  public error(message: string, component: string = "System", data?: any): void {
    this.log("ERROR", message, component, data);
  }

  public close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.logStream) {
        this.log("INFO", "Process logger closing");
        this.logStream.end(() => {
          this.logStream = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  public getLogFilePath(): string | undefined {
    return this.logFilePath;
  }
}

// Global instance
let globalProcessLogger: ProcessLogger | null = null;

export function initProcessLogger(logDir?: string, enabled?: boolean): ProcessLogger {
  if (!globalProcessLogger) {
    globalProcessLogger = new ProcessLogger(logDir, enabled);
  } else {
    console.warn("[ProcessLogger] Already initialized, ignoring new parameters");
  }
  return globalProcessLogger;
}

export function getProcessLogger(): ProcessLogger | null {
  return globalProcessLogger;
}

export async function closeProcessLogger(): Promise<void> {
  if (globalProcessLogger) {
    await globalProcessLogger.close();
    globalProcessLogger = null;
  }
}

export { ProcessLogger };
