#!/usr/bin/env node
import { runModuleTool } from './module-tool-bundle.mjs';
await runModuleTool('official', process.argv.slice(2));
