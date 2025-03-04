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
import { Page } from '../../page';
import { ProgressController } from '../../progress';
import { EventEmitter } from 'events';
import { internalCallMetadata } from '../../instrumentation';
import type { CallLog, EventData, Mode, Source } from './recorderTypes';
import { isUnderTest } from '../../../utils/utils';
import * as mime from 'mime';
import { installAppIcon } from '../../chromium/crApp';
import { findChromiumChannel } from '../../../utils/registry';

declare global {
  interface Window {
    playwrightSetFile: (file: string) => void;
    playwrightSetMode: (mode: Mode) => void;
    playwrightSetPaused: (paused: boolean) => void;
    playwrightSetSources: (sources: Source[]) => void;
    playwrightSetSelector: (selector: string, focus?: boolean) => void;
    playwrightUpdateLogs: (callLogs: CallLog[]) => void;
    dispatch(data: EventData): Promise<void>;
  }
}

export class RecorderApp extends EventEmitter {
  private _page: Page;
  readonly wsEndpoint: string | undefined;

  constructor(page: Page, wsEndpoint: string | undefined) {
    super();
    this.setMaxListeners(0);
    this._page = page;
    this.wsEndpoint = wsEndpoint;
  }

  async close() {
    await this._page.context().close(internalCallMetadata());
  }

  private async _init() {
    await installAppIcon(this._page);

    await this._page._setServerRequestInterceptor(async route => {
      if (route.request().url().startsWith('https://playwright/')) {
        const uri = route.request().url().substring('https://playwright/'.length);
        const file = require.resolve('../../../webpack/recorder/' + uri);
        const buffer = await fs.promises.readFile(file);
        await route.fulfill({
          status: 200,
          headers: [
            { name: 'Content-Type', value: mime.getType(path.extname(file)) || 'application/octet-stream' }
          ],
          body: buffer.toString('base64'),
          isBase64: true
        });
        return;
      }
      await route.continue();
    });

    await this._page.exposeBinding('dispatch', false, (_, data: any) => this.emit('event', data));

    this._page.once('close', () => {
      this.emit('close');
      this._page.context().close(internalCallMetadata()).catch(e => console.error(e));
    });

    const mainFrame = this._page.mainFrame();
    await mainFrame.goto(internalCallMetadata(), 'https://playwright/index.html');
  }

  static async open(sdkLanguage: string, headed: boolean): Promise<RecorderApp> {
    const recorderPlaywright = (require('../../playwright').createPlaywright as typeof import('../../playwright').createPlaywright)('javascript', true);
    const args = [
      '--app=data:text/html,',
      '--window-size=600,600',
      '--window-position=1280,10',
    ];
    if (process.env.PWTEST_RECORDER_PORT)
      args.push(`--remote-debugging-port=${process.env.PWTEST_RECORDER_PORT}`);
    const context = await recorderPlaywright.chromium.launchPersistentContext(internalCallMetadata(), '', {
      channel: findChromiumChannel(sdkLanguage),
      args,
      noDefaultViewport: true,
      headless: !!process.env.PWTEST_CLI_HEADLESS || (isUnderTest() && !headed),
      useWebSocket: !!process.env.PWTEST_RECORDER_PORT
    });
    const controller = new ProgressController(internalCallMetadata(), context._browser);
    await controller.run(async progress => {
      await context._browser._defaultContext!._loadDefaultContextAsIs(progress);
    });

    const [page] = context.pages();
    const result = new RecorderApp(page, context._browser.options.wsEndpoint);
    await result._init();
    return result;
  }

  async setMode(mode: 'none' | 'recording' | 'inspecting'): Promise<void> {
    await this._page.mainFrame().evaluateExpression(((mode: Mode) => {
      window.playwrightSetMode(mode);
    }).toString(), true, mode, 'main').catch(() => {});
  }

  async setFile(file: string): Promise<void> {
    await this._page.mainFrame().evaluateExpression(((file: string) => {
      window.playwrightSetFile(file);
    }).toString(), true, file, 'main').catch(() => {});
  }

  async setPaused(paused: boolean): Promise<void> {
    await this._page.mainFrame().evaluateExpression(((paused: boolean) => {
      window.playwrightSetPaused(paused);
    }).toString(), true, paused, 'main').catch(() => {});
  }

  async setSources(sources: Source[]): Promise<void> {
    await this._page.mainFrame().evaluateExpression(((sources: Source[]) => {
      window.playwrightSetSources(sources);
    }).toString(), true, sources, 'main').catch(() => {});

    // Testing harness for runCLI mode.
    {
      if (process.env.PWTEST_CLI_EXIT && sources.length) {
        process.stdout.write('\n-------------8<-------------\n');
        process.stdout.write(sources[0].text);
        process.stdout.write('\n-------------8<-------------\n');
      }
    }
  }

  async setSelector(selector: string, focus?: boolean): Promise<void> {
    await this._page.mainFrame().evaluateExpression(((arg: any) => {
      window.playwrightSetSelector(arg.selector, arg.focus);
    }).toString(), true, { selector, focus }, 'main').catch(() => {});
  }

  async updateCallLogs(callLogs: CallLog[]): Promise<void> {
    await this._page.mainFrame().evaluateExpression(((callLogs: CallLog[]) => {
      window.playwrightUpdateLogs(callLogs);
    }).toString(), true, callLogs, 'main').catch(() => {});
  }

  async bringToFront() {
    await this._page.bringToFront();
  }
}
