/**
 * Logging Utility for Perspecta
 *
 * Provides centralized logging with configurable levels.
 * Per Obsidian plugin guidelines: "Minimize console logging"
 * Only errors should appear in production; debug messages only when enabled.
 *
 * @module utils/logger
 */

/**
 * Log levels from most to least severe.
 */
export enum LogLevel {
	/** No logging */
	NONE = 0,
	/** Only errors */
	ERROR = 1,
	/** Errors and warnings */
	WARN = 2,
	/** Errors, warnings, and info */
	INFO = 3,
	/** All messages including debug */
	DEBUG = 4
}

/**
 * Logger configuration.
 */
interface LoggerConfig {
	/** Current log level */
	level: LogLevel;
	/** Prefix for all log messages */
	prefix: string;
}

/**
 * Default configuration - production mode (errors only).
 */
const config: LoggerConfig = {
	level: LogLevel.ERROR,
	prefix: '[Perspecta]'
};

/**
 * Sets the logging level.
 *
 * @param level - New log level
 *
 * @example
 * ```typescript
 * // Enable debug logging
 * setLogLevel(LogLevel.DEBUG);
 *
 * // Production mode (errors only)
 * setLogLevel(LogLevel.ERROR);
 * ```
 */
export function setLogLevel(level: LogLevel): void {
	config.level = level;
}

/**
 * Gets the current logging level.
 */
export function getLogLevel(): LogLevel {
	return config.level;
}

/**
 * Enables debug mode (all messages).
 */
export function enableDebugMode(): void {
	config.level = LogLevel.DEBUG;
}

/**
 * Disables debug mode (errors only).
 */
export function disableDebugMode(): void {
	config.level = LogLevel.ERROR;
}

/**
 * Checks if debug mode is enabled.
 */
export function isDebugEnabled(): boolean {
	return config.level >= LogLevel.DEBUG;
}

/**
 * Logs an error message.
 * Always logged unless level is NONE.
 *
 * @param message - Error message
 * @param args - Additional arguments
 */
export function logError(message: string, ...args: unknown[]): void {
	if (config.level >= LogLevel.ERROR) {
		console.error(`${config.prefix} ${message}`, ...args);
	}
}

/**
 * Logs a warning message.
 * Only logged at WARN level or above.
 *
 * @param message - Warning message
 * @param args - Additional arguments
 */
export function logWarn(message: string, ...args: unknown[]): void {
	if (config.level >= LogLevel.WARN) {
		console.warn(`${config.prefix} ${message}`, ...args);
	}
}

/**
 * Logs an info message.
 * Only logged at INFO level or above.
 *
 * @param message - Info message
 * @param args - Additional arguments
 */
export function logInfo(message: string, ...args: unknown[]): void {
	if (config.level >= LogLevel.INFO) {
		console.log(`${config.prefix} ${message}`, ...args);
	}
}

/**
 * Logs a debug message.
 * Only logged at DEBUG level.
 *
 * @param message - Debug message
 * @param args - Additional arguments
 */
export function logDebug(message: string, ...args: unknown[]): void {
	if (config.level >= LogLevel.DEBUG) {
		console.log(`${config.prefix} [DEBUG] ${message}`, ...args);
	}
}

/**
 * Logger object with all methods for convenient importing.
 *
 * @example
 * ```typescript
 * import { Logger } from './utils/logger';
 *
 * Logger.debug('Processing file:', file.path);
 * Logger.error('Failed to save:', error);
 * ```
 */
export const Logger = {
	error: logError,
	warn: logWarn,
	info: logInfo,
	debug: logDebug,
	setLevel: setLogLevel,
	getLevel: getLogLevel,
	enableDebug: enableDebugMode,
	disableDebug: disableDebugMode,
	isDebugEnabled
};
