#!/usr/bin/env node
import { runModuleTool } from './module-tool-bundle.mjs';
await runModuleTool('verify', process.argv.slice(2));
