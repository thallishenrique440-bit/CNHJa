/**
 * ProjectionLogger.ts
 * CNHJá Financial Architecture v1.0 (Etapa 7.1 Hardening - Structured Logging)
 *
 * Provides JSON structured logs for observability with context, level, eventType, identifier, timestamp.
 */

export enum LogLevel {
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
  DEBUG = 'DEBUG'
}

export interface StructuredLogPayload {
  timestamp: string;
  level: LogLevel;
  context: string;
  eventType?: string;
  identifier?: string;
  message: string;
  metadata?: Record<string, any>;
}

export class ProjectionLogger {
  public static log(
    level: LogLevel,
    context: string,
    message: string,
    options?: {
      eventType?: string;
      identifier?: string;
      metadata?: Record<string, any>;
    }
  ): void {
    const logPayload: StructuredLogPayload = {
      timestamp: new Date().toISOString(),
      level,
      context,
      eventType: options?.eventType,
      identifier: options?.identifier,
      message,
      metadata: options?.metadata
    };

    const formattedLog = JSON.stringify(logPayload);

    switch (level) {
      case LogLevel.ERROR:
        console.error(formattedLog);
        break;
      case LogLevel.WARN:
        console.warn(formattedLog);
        break;
      case LogLevel.INFO:
      case LogLevel.DEBUG:
      default:
        console.log(formattedLog);
        break;
    }
  }

  public static info(
    context: string,
    message: string,
    options?: { eventType?: string; identifier?: string; metadata?: Record<string, any> }
  ) {
    this.log(LogLevel.INFO, context, message, options);
  }

  public static warn(
    context: string,
    message: string,
    options?: { eventType?: string; identifier?: string; metadata?: Record<string, any> }
  ) {
    this.log(LogLevel.WARN, context, message, options);
  }

  public static error(
    context: string,
    message: string,
    options?: { eventType?: string; identifier?: string; metadata?: Record<string, any> }
  ) {
    this.log(LogLevel.ERROR, context, message, options);
  }
}
