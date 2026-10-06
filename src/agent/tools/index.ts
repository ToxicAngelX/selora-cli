/**
 * The built-in tool set the agent loop ships with. Fresh instances per call
 * (tools are stateless), so tests and the CLI never share mutable tool state.
 * Nothing here is registered behind a flag or hidden — the full list is what
 * the model sees on the wire and what docs/agent.md documents.
 */

import type { Tool } from '../tool.js';
import { editFileTool, readFileTool, writeFileTool } from './files.js';
import { runCommandTool } from './exec.js';
import { globTool, grepTool } from './search.js';
import { gitCommitTool, gitDiffTool, gitLogTool, gitRestoreTool, gitStatusTool } from './git.js';
import { copyTool, createDirTool, listDirTool, moveTool, removeTool } from './fs.js';
import { webFetchTool, webSearchTool } from './web.js';

/** The built-in tools, in a stable order (wire order + docs order). */
export function builtinTools(): Tool[] {
  return [
    readFileTool,
    writeFileTool,
    editFileTool,
    listDirTool,
    createDirTool,
    moveTool,
    copyTool,
    removeTool,
    globTool,
    grepTool,
    runCommandTool,
    webSearchTool,
    webFetchTool,
    gitStatusTool,
    gitDiffTool,
    gitLogTool,
    gitCommitTool,
    gitRestoreTool,
  ];
}
