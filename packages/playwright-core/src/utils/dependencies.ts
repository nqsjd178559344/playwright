/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'fs';
import path from 'path';
import * as os from 'os';
import childProcess from 'child_process';
import * as utils from './utils';
import { buildPlaywrightCLICommand } from './registry';
import { deps } from './nativeDeps';

const BIN_DIRECTORY = path.join(__dirname, '..', '..', 'bin');

const checkExecutable = (filePath: string) => fs.promises.access(filePath, fs.constants.X_OK).then(() => true).catch(e => false);

function isSupportedWindowsVersion(): boolean {
  if (os.platform() !== 'win32' || os.arch() !== 'x64')
    return false;
  const [major, minor] = os.release().split('.').map(token => parseInt(token, 10));
  // This is based on: https://stackoverflow.com/questions/42524606/how-to-get-windows-version-using-node-js/44916050#44916050
  // The table with versions is taken from: https://docs.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-osversioninfoexw#remarks
  // Windows 7 is not supported and is encoded as `6.1`.
  return major > 6 || (major === 6 && minor > 1);
}

export type DependencyGroup = 'chromium' | 'firefox' | 'webkit' | 'tools';

export async function installDependenciesWindows(targets: Set<DependencyGroup>, dryRun: boolean): Promise<void> {
  if (targets.has('chromium')) {
    const command = 'powershell.exe';
    const args = ['-ExecutionPolicy', 'Bypass', '-File', path.join(BIN_DIRECTORY, 'install_media_pack.ps1')];
    if (dryRun) {
      console.log(`${command} ${quoteProcessArgs(args).join(' ')}`); // eslint-disable-line no-console
      return;
    }
    const { code } = await utils.spawnAsync(command, args, { cwd: BIN_DIRECTORY, stdio: 'inherit' });
    if (code !== 0)
      throw new Error('Failed to install windows dependencies!');
  }
}

export async function installDependenciesLinux(targets: Set<DependencyGroup>, dryRun: boolean) {
  const libraries: string[] = [];
  for (const target of targets) {
    const info = deps[utils.hostPlatform];
    if (!info) {
      console.warn('Cannot install dependencies for this linux distribution!');  // eslint-disable-line no-console
      return;
    }
    libraries.push(...info[target]);
  }
  const uniqueLibraries = Array.from(new Set(libraries));
  if (!dryRun)
    console.log('Installing Ubuntu dependencies...');  // eslint-disable-line no-console
  const commands: string[] = [];
  commands.push('apt-get update');
  commands.push(['apt-get', 'install', '-y', '--no-install-recommends',
    ...uniqueLibraries,
  ].join(' '));
  const { command, args, elevatedPermissions } = await utils.transformCommandsForRoot(commands);
  if (dryRun) {
    console.log(`${command} ${quoteProcessArgs(args).join(' ')}`); // eslint-disable-line no-console
    return;
  }
  if (elevatedPermissions)
    console.log('Switching to root user to install dependencies...'); // eslint-disable-line no-console
  const child = childProcess.spawn(command, args, { stdio: 'inherit' });
  await new Promise((resolve, reject) => {
    child.on('exit', resolve);
    child.on('error', reject);
  });
}

export async function validateDependenciesWindows(windowsExeAndDllDirectories: string[]) {
  const directoryPaths = windowsExeAndDllDirectories;
  const lddPaths: string[] = [];
  for (const directoryPath of directoryPaths)
    lddPaths.push(...(await executablesOrSharedLibraries(directoryPath)));
  const allMissingDeps = await Promise.all(lddPaths.map(lddPath => missingFileDependenciesWindows(lddPath)));
  const missingDeps: Set<string> = new Set();
  for (const deps of allMissingDeps) {
    for (const dep of deps)
      missingDeps.add(dep);
  }

  if (!missingDeps.size)
    return;

  let isCrtMissing = false;
  let isMediaFoundationMissing = false;
  for (const dep of missingDeps) {
    if (dep.startsWith('api-ms-win-crt') || dep === 'vcruntime140.dll' || dep === 'vcruntime140_1.dll' || dep === 'msvcp140.dll')
      isCrtMissing = true;
    else if (dep === 'mf.dll' || dep === 'mfplat.dll' ||  dep === 'msmpeg2vdec.dll' || dep === 'evr.dll' || dep === 'avrt.dll')
      isMediaFoundationMissing = true;
  }

  const details = [];

  if (isCrtMissing) {
    details.push(
        `Some of the Universal C Runtime files cannot be found on the system. You can fix`,
        `that by installing Microsoft Visual C++ Redistributable for Visual Studio from:`,
        `https://support.microsoft.com/en-us/help/2977003/the-latest-supported-visual-c-downloads`,
        ``);
  }

  if (isMediaFoundationMissing) {
    details.push(
        `Some of the Media Foundation files cannot be found on the system. If you are`,
        `on Windows Server try fixing this by running the following command in PowerShell`,
        `as Administrator:`,
        ``,
        `    Install-WindowsFeature Server-Media-Foundation`,
        ``,
        `For Windows N editions visit:`,
        `https://support.microsoft.com/en-us/help/3145500/media-feature-pack-list-for-windows-n-editions`,
        ``);
  }

  details.push(
      `Full list of missing libraries:`,
      `    ${[...missingDeps].join('\n    ')}`,
      ``);

  const message = `Host system is missing dependencies!\n\n${details.join('\n')}`;
  if (isSupportedWindowsVersion()) {
    throw new Error(message);
  } else {
    console.warn(`WARNING: running on unsupported windows version!`);
    console.warn(message);
  }
}

export async function validateDependenciesLinux(sdkLanguage: string, linuxLddDirectories: string[], dlOpenLibraries: string[]) {
  const directoryPaths = linuxLddDirectories;
  const lddPaths: string[] = [];
  for (const directoryPath of directoryPaths)
    lddPaths.push(...(await executablesOrSharedLibraries(directoryPath)));
  const allMissingDeps = await Promise.all(lddPaths.map(lddPath => missingFileDependencies(lddPath, directoryPaths)));
  const missingDeps: Set<string> = new Set();
  for (const deps of allMissingDeps) {
    for (const dep of deps)
      missingDeps.add(dep);
  }
  for (const dep of (await missingDLOPENLibraries(dlOpenLibraries)))
    missingDeps.add(dep);
  if (!missingDeps.size)
    return;
  // Check Ubuntu version.
  const missingPackages = new Set();

  const libraryToPackageNameMapping = {
    ...(deps[utils.hostPlatform]?.lib2package || {}),
    ...MANUAL_LIBRARY_TO_PACKAGE_NAME_UBUNTU,
  };
  // Translate missing dependencies to package names to install with apt.
  for (const missingDep of missingDeps) {
    const packageName = libraryToPackageNameMapping[missingDep];
    if (packageName) {
      missingPackages.add(packageName);
      missingDeps.delete(missingDep);
    }
  }

  const maybeSudo = (process.getuid() !== 0) && os.platform() !== 'win32' ? 'sudo ' : '';
  // Happy path: known dependencies are missing for browsers.
  // Suggest installation with a Playwright CLI.
  if (missingPackages.size && !missingDeps.size) {
    throw new Error('\n' + utils.wrapInASCIIBox([
      `Host system is missing a few dependencies to run browsers.`,
      `Please install them with the following command:`,
      ``,
      `    ${maybeSudo}${buildPlaywrightCLICommand(sdkLanguage, 'install-deps')}`,
      ``,
      `<3 Playwright Team`,
    ].join('\n'), 1));
  }

  // Unhappy path - unusual distribution configuration.
  let missingPackagesMessage = '';
  if (missingPackages.size) {
    missingPackagesMessage = [
      `  Install missing packages with:`,
      `      ${maybeSudo}apt-get install ${[...missingPackages].join('\\\n          ')}`,
      ``,
      ``,
    ].join('\n');
  }

  let missingDependenciesMessage = '';
  if (missingDeps.size) {
    const header = missingPackages.size ? `Missing libraries we didn't find packages for:` : `Missing libraries are:`;
    missingDependenciesMessage = [
      `  ${header}`,
      `      ${[...missingDeps].join('\n      ')}`,
      ``,
    ].join('\n');
  }

  throw new Error('Host system is missing dependencies!\n\n' + missingPackagesMessage + missingDependenciesMessage);
}

function isSharedLib(basename: string) {
  switch (os.platform()) {
    case 'linux':
      return basename.endsWith('.so') || basename.includes('.so.');
    case 'win32':
      return basename.endsWith('.dll');
    default:
      return false;
  }
}

async function executablesOrSharedLibraries(directoryPath: string): Promise<string[]> {
  const allPaths = (await fs.promises.readdir(directoryPath)).map(file => path.resolve(directoryPath, file));
  const allStats = await Promise.all(allPaths.map(aPath => fs.promises.stat(aPath)));
  const filePaths = allPaths.filter((aPath, index) => (allStats[index] as any).isFile());

  const executablersOrLibraries = (await Promise.all(filePaths.map(async filePath => {
    const basename = path.basename(filePath).toLowerCase();
    if (isSharedLib(basename))
      return filePath;
    if (await checkExecutable(filePath))
      return filePath;
    return false;
  }))).filter(Boolean);

  return executablersOrLibraries as string[];
}

async function missingFileDependenciesWindows(filePath: string): Promise<Array<string>> {
  const executable = path.join(__dirname, '..', '..', 'bin', 'PrintDeps.exe');
  const dirname = path.dirname(filePath);
  const { stdout, code } = await utils.spawnAsync(executable, [filePath], {
    cwd: dirname,
    env: {
      ...process.env,
      LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH ? `${process.env.LD_LIBRARY_PATH}:${dirname}` : dirname,
    },
  });
  if (code !== 0)
    return [];
  const missingDeps = stdout.split('\n').map(line => line.trim()).filter(line => line.endsWith('not found') && line.includes('=>')).map(line => line.split('=>')[0].trim().toLowerCase());
  return missingDeps;
}

async function missingFileDependencies(filePath: string, extraLDPaths: string[]): Promise<Array<string>> {
  const dirname = path.dirname(filePath);
  let LD_LIBRARY_PATH = extraLDPaths.join(':');
  if (process.env.LD_LIBRARY_PATH)
    LD_LIBRARY_PATH = `${process.env.LD_LIBRARY_PATH}:${LD_LIBRARY_PATH}`;
  const { stdout, code } = await utils.spawnAsync('ldd', [filePath], {
    cwd: dirname,
    env: {
      ...process.env,
      LD_LIBRARY_PATH,
    },
  });
  if (code !== 0)
    return [];
  const missingDeps = stdout.split('\n').map(line => line.trim()).filter(line => line.endsWith('not found') && line.includes('=>')).map(line => line.split('=>')[0].trim());
  return missingDeps;
}

async function missingDLOPENLibraries(libraries: string[]): Promise<string[]> {
  if (!libraries.length)
    return [];
  // NOTE: Using full-qualified path to `ldconfig` since `/sbin` is not part of the
  // default PATH in CRON.
  // @see https://github.com/microsoft/playwright/issues/3397
  const { stdout, code, error } = await utils.spawnAsync('/sbin/ldconfig', ['-p'], {});
  if (code !== 0 || error)
    return [];
  const isLibraryAvailable = (library: string) => stdout.toLowerCase().includes(library.toLowerCase());
  return libraries.filter(library => !isLibraryAvailable(library));
}

const MANUAL_LIBRARY_TO_PACKAGE_NAME_UBUNTU: { [s: string]: string} = {
  // libgstlibav.so (the only actual library provided by gstreamer1.0-libav) is not
  // in the ldconfig cache, so we detect the actual library required for playing h.264
  // and if it's missing recommend installing missing gstreamer lib.
  // gstreamer1.0-libav -> libavcodec57 -> libx264-152
  'libx264.so': 'gstreamer1.0-libav',
};

function quoteProcessArgs(args: string[]): string[] {
  return args.map(arg => {
    if (arg.includes(' '))
      return `"${arg}"`;
    return arg;
  });
}
