#!/usr/bin/env node
import { runModuleTool } from './module-tool-bundle.mjs';
await runModuleTool('validate', process.argv.slice(2));
