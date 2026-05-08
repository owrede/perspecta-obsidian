// Minimal stub for `obsidian` module so tests can import files that
// transitively reference it. Tests should never *use* these — they should
// pass plain test fixtures into the function under test. The stub exists
// only to satisfy module resolution at import time.

export class TFile {
	path = '';
	name = '';
	basename = '';
	extension = '';
}

export class TAbstractFile {
	path = '';
}

export class App {}
export class Notice { constructor(_msg: string) {} }
export class Plugin {}
export class WorkspaceLeaf {}
export class Menu {}
export class MenuItem {}
export class FileSystemAdapter {}
export const setIcon = (_el: HTMLElement, _name: string): void => {};
export const parseYaml = (s: string): unknown => JSON.parse(s);
export const stringifyYaml = (o: unknown): string => JSON.stringify(o);
