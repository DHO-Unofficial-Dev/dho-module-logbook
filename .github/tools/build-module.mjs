#!/usr/bin/env node
import { runModuleTool } from './module-tool-bundle.mjs';
await runModuleTool('build', process.argv.slice(2));
