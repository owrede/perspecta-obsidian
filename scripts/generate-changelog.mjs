#!/usr/bin/env node
/**
 * Generate CHANGELOG.md from the changelog data in src/changelog.ts
 * Run with: node scripts/generate-changelog.mjs
 *
 * This script compiles the TypeScript file to extract the CHANGELOG data,
 * then generates CHANGELOG.md from it.
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

const checkOnly = process.argv.includes('--check');

// Read the TypeScript changelog file
const changelogTsPath = join(rootDir, 'src', 'changelog.ts');
const changelogTsContent = readFileSync(changelogTsPath, 'utf-8');

// Parse entries by finding version blocks
const entries = [];
const versionBlockRegex = /\{\s*version:\s*'([^']+)'(?:,\s*date:\s*'([^']+)')?,\s*changes:\s*\[([\s\S]*?)\],?\s*\}/g;

let match;
while ((match = versionBlockRegex.exec(changelogTsContent)) !== null) {
	const version = match[1];
	const date = match[2] || null;
	const changesBlock = match[3];

	// Extract individual changes - handle both single and double quotes, and escaped quotes
	const changes = [];
	// Match strings that start with ' and end with ' (not preceded by \)
	// This regex handles the content between quotes more carefully
	const lines = changesBlock.split('\n');
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("'") && trimmed.includes("',")) {
			// Extract content between first ' and last ',
			const content = trimmed.slice(1, trimmed.lastIndexOf("',"));
			if (content) {
				changes.push(content);
			}
		} else if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
			// Last item without trailing comma
			const content = trimmed.slice(1, -1);
			if (content) {
				changes.push(content);
			}
		}
	}

	entries.push({ version, date, changes });
}

if (entries.length === 0) {
	console.error('Could not parse any changelog entries from src/changelog.ts');
	process.exit(1);
}

// Generate markdown
const lines = [
	'# Changelog',
	'',
	'All notable changes to Perspecta will be documented in this file.',
	'',
];

for (const entry of entries) {
	lines.push(`## [${entry.version}]${entry.date ? ` - ${entry.date}` : ''}`);
	lines.push('');
	for (const change of entry.changes) {
		lines.push(`- ${change}`);
	}
	lines.push('');
}

const changelogMd = lines.join('\n');

// Write CHANGELOG.md
const changelogPath = join(rootDir, 'CHANGELOG.md');
if (checkOnly) {
	let current = '';
	try {
		current = readFileSync(changelogPath, 'utf-8');
	} catch {
		current = '';
	}

	if (current !== changelogMd) {
		console.error(`CHANGELOG.md is out of date. Run: npm run changelog`);
		process.exit(1);
	}
	console.log(`CHANGELOG.md is up to date (${entries.length} versions)`);
} else {
	writeFileSync(changelogPath, changelogMd);
	console.log(`Generated ${changelogPath} with ${entries.length} versions`);
}
