/**
 * Structured Logger Utility
 * Provides consistent logging with log levels and context
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

interface LogEntry {
  level: LogLevel;
  component: string;
  action: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: number;
}

class Logger {
  private minLevel: LogLevel;
  private isProduction: boolean;

  constructor() {
    // In production, only show WARN and ERROR
    this.isProduction = process.env.NODE_ENV === 'production';
    this.minLevel = this.isProduction ? LogLevel.WARN : LogLevel.DEBUG;
  }

  private shouldLog(level: LogLevel): boolean {
    return level >= this.minLevel;
  }

  private formatMessage(entry: LogEntry): string {
    const levelName = LogLevel[entry.level];
    const timestamp = new Date(entry.timestamp).toISOString();
    const prefix = `[${timestamp}] [${levelName}] [${entry.component}] ${entry.action ? `[${entry.action}]` : ''}`;
    
    if (entry.data) {
      return `${prefix} ${entry.message} ${JSON.stringify(entry.data)}`;
    }
    return `${prefix} ${entry.message}`;
  }

  private log(level: LogLevel, component: string, action: string, message: string, data?: Record<string, any>): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const entry: LogEntry = {
      level,
      component,
      action,
      message,
      data,
      timestamp: Date.now(),
    };

    const formattedMessage = this.formatMessage(entry);

    switch (level) {
      case LogLevel.DEBUG:
        console.debug(formattedMessage);
        break;
      case LogLevel.INFO:
        console.log(formattedMessage);
        break;
      case LogLevel.WARN:
        console.warn(formattedMessage);
        break;
      case LogLevel.ERROR:
        console.error(formattedMessage);
        break;
    }
  }

  debug(component: string, action: string, message: string, data?: Record<string, any>): void {
    this.log(LogLevel.DEBUG, component, action, message, data);
  }

  info(component: string, action: string, message: string, data?: Record<string, any>): void {
    this.log(LogLevel.INFO, component, action, message, data);
  }

  warn(component: string, action: string, message: string, data?: Record<string, any>): void {
    this.log(LogLevel.WARN, component, action, message, data);
  }

  error(component: string, action: string, message: string, error?: Error | unknown, data?: Record<string, any>): void {
    const errorData: Record<string, any> = { ...data };
    
    if (error instanceof Error) {
      errorData.error = {
        name: error.name,
        message: error.message,
        stack: this.isProduction ? undefined : error.stack,
      };
    } else if (error) {
      errorData.error = String(error);
    }

    this.log(LogLevel.ERROR, component, action, message, errorData);
  }

  /**
   * Set minimum log level (useful for testing or filtering)
   */
  setMinLevel(level: LogLevel): void {
    this.minLevel = level;
  }
}

// Export singleton instance
export const logger = new Logger();
