// Subconjunto de la API pública de la extensión vscode.git, con solo lo que usa
// apus. La definición completa está en microsoft/vscode, en
// extensions/git/src/api/git.d.ts.

import * as vscode from 'vscode';

export interface GitExtension {
  getAPI(version: 1): GitAPI;
}

export interface GitAPI {
  readonly git: { readonly path: string };
  readonly repositories: Repository[];
  readonly onDidOpenRepository: vscode.Event<Repository>;
  readonly onDidCloseRepository: vscode.Event<Repository>;
}

export interface Repository {
  readonly rootUri: vscode.Uri;
  readonly state: RepositoryState;
}

export interface RepositoryState {
  readonly HEAD: Branch | undefined;
  readonly remotes: Remote[];
  readonly mergeChanges: Change[];
  readonly indexChanges: Change[];
  readonly workingTreeChanges: Change[];
  /** Solo existe en versiones recientes, y solo se llena con git.untrackedChanges = "separate". */
  readonly untrackedChanges?: Change[];
  readonly onDidChange: vscode.Event<void>;
}

export interface Branch {
  readonly name?: string;
  readonly commit?: string;
  readonly upstream?: { readonly remote: string; readonly name: string };
  readonly ahead?: number;
}

export interface Remote {
  readonly name: string;
  readonly fetchUrl?: string;
  readonly pushUrl?: string;
}

export interface Change {
  readonly uri: vscode.Uri;
  readonly status: number;
}

export async function getGitApi(log: vscode.LogOutputChannel): Promise<GitAPI | undefined> {
  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!extension) {
    log.error('the built-in Git extension is not installed');
    return undefined;
  }
  try {
    const exports = extension.isActive ? extension.exports : await extension.activate();
    return exports.getAPI(1);
  } catch (e) {
    // getAPI falla si el usuario apagó git.enabled.
    log.error('the built-in Git extension is not available:', e instanceof Error ? e.message : String(e));
    return undefined;
  }
}
