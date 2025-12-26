/**
 * Services Index
 *
 * Exports all service classes for use in the main plugin.
 *
 * ## Architecture Notes
 *
 * The services layer contains business logic extracted from main.ts:
 *
 * - **WindowCaptureService**: Captures current window arrangement state
 * - **WindowRestoreService**: Restores window arrangements from saved state
 * - **IndicatorsService**: Manages file explorer context indicators
 *
 * These services are designed to be used incrementally - main.ts can
 * gradually delegate functionality to these services over time.
 */

export { WindowCaptureService, createWindowCaptureService } from './window-capture';
export type { CaptureOptions } from './window-capture';

export { WindowRestoreService, createWindowRestoreService } from './window-restore';
export type { RestoreOptions, PathCorrection } from './window-restore';

export { IndicatorsService } from './indicators';
export type { IndicatorsConfig } from './indicators';
