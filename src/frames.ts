/**
 * Copyright 2017 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as types from './types';
import * as fs from 'fs';
import * as js from './javascript';
import * as dom from './dom';
import * as network from './network';
import { helper, assert } from './helper';
import { ClickOptions, MultiClickOptions, PointerActionOptions, SelectOption } from './input';
import { waitForSelectorOrXPath, WaitTaskParams, WaitTask } from './waitTask';
import { TimeoutSettings } from './TimeoutSettings';

const readFileAsync = helper.promisify(fs.readFile);

type WorldType = 'main' | 'utility';
type World = {
  contextPromise: Promise<js.ExecutionContext>;
  contextResolveCallback: (c: js.ExecutionContext) => void;
  context: js.ExecutionContext | null;
  waitTasks: Set<WaitTask>;
};

export type NavigateOptions = {
  timeout?: number,
  waitUntil?: string | string[],
};

export type GotoOptions = NavigateOptions & {
  referer?: string,
};

export interface FrameDelegate {
  timeoutSettings(): TimeoutSettings;
  navigateFrame(frame: Frame, url: string, options?: GotoOptions): Promise<network.Response | null>;
  waitForFrameNavigation(frame: Frame, options?: NavigateOptions): Promise<network.Response | null>;
  setFrameContent(frame: Frame, html: string, options?: NavigateOptions): Promise<void>;
  adoptElementHandle(elementHandle: dom.ElementHandle, context: js.ExecutionContext): Promise<dom.ElementHandle>;
}

export class Frame {
  _delegate: FrameDelegate;
  private _parentFrame: Frame;
  private _url = '';
  private _detached = false;
  private _worlds = new Map<WorldType, World>();
  private _childFrames = new Set<Frame>();
  private _name: string;

  constructor(delegate: FrameDelegate, parentFrame: Frame | null) {
    this._delegate = delegate;
    this._parentFrame = parentFrame;

    this._worlds.set('main', { contextPromise: new Promise(() => {}), contextResolveCallback: () => {}, context: null, waitTasks: new Set() });
    this._worlds.set('utility', { contextPromise: new Promise(() => {}), contextResolveCallback: () => {}, context: null, waitTasks: new Set() });
    this._setContext('main', null);
    this._setContext('utility', null);

    if (this._parentFrame)
      this._parentFrame._childFrames.add(this);
  }

  goto(url: string, options?: GotoOptions): Promise<network.Response | null> {
    return this._delegate.navigateFrame(this, url, options);
  }

  waitForNavigation(options?: NavigateOptions): Promise<network.Response | null> {
    return this._delegate.waitForFrameNavigation(this, options);
  }

  _mainContext(): Promise<js.ExecutionContext> {
    if (this._detached)
      throw new Error(`Execution Context is not available in detached frame "${this.url()}" (are you trying to evaluate?)`);
    return this._worlds.get('main').contextPromise;
  }

  _utilityContext(): Promise<js.ExecutionContext> {
    if (this._detached)
      throw new Error(`Execution Context is not available in detached frame "${this.url()}" (are you trying to evaluate?)`);
    return this._worlds.get('utility').contextPromise;
  }

  executionContext(): Promise<js.ExecutionContext> {
    return this._mainContext();
  }

  evaluateHandle: types.EvaluateHandle<js.JSHandle> = async (pageFunction, ...args) => {
    const context = await this._mainContext();
    return context.evaluateHandle(pageFunction, ...args as any);
  }

  evaluate: types.Evaluate<js.JSHandle> = async (pageFunction, ...args) => {
    const context = await this._mainContext();
    return context.evaluate(pageFunction, ...args as any);
  }

  async $(selector: string): Promise<dom.ElementHandle | null> {
    const context = await this._mainContext();
    const document = await context._document();
    return document.$(selector);
  }

  async $x(expression: string): Promise<dom.ElementHandle[]> {
    const context = await this._mainContext();
    const document = await context._document();
    return document.$x(expression);
  }

  $eval: types.$Eval<js.JSHandle> = async (selector, pageFunction, ...args) => {
    const context = await this._mainContext();
    const document = await context._document();
    return document.$eval(selector, pageFunction, ...args as any);
  }

  $$eval: types.$$Eval<js.JSHandle> = async (selector, pageFunction, ...args) => {
    const context = await this._mainContext();
    const document = await context._document();
    return document.$$eval(selector, pageFunction, ...args as any);
  }

  async $$(selector: string): Promise<dom.ElementHandle[]> {
    const context = await this._mainContext();
    const document = await context._document();
    return document.$$(selector);
  }

  async content(): Promise<string> {
    const context = await this._utilityContext();
    return context.evaluate(() => {
      let retVal = '';
      if (document.doctype)
        retVal = new XMLSerializer().serializeToString(document.doctype);
      if (document.documentElement)
        retVal += document.documentElement.outerHTML;
      return retVal;
    });
  }

  setContent(html: string, options?: NavigateOptions) {
    return this._delegate.setFrameContent(this, html, options);
  }

  name(): string {
    return this._name || '';
  }

  url(): string {
    return this._url;
  }

  parentFrame(): Frame | null {
    return this._parentFrame;
  }

  childFrames(): Frame[] {
    return Array.from(this._childFrames);
  }

  isDetached(): boolean {
    return this._detached;
  }

  async addScriptTag(options: {
      url?: string; path?: string;
      content?: string;
      type?: string;
    }): Promise<dom.ElementHandle> {
    const {
      url = null,
      path = null,
      content = null,
      type = ''
    } = options;
    if (url !== null) {
      try {
        const context = await this._mainContext();
        return (await context.evaluateHandle(addScriptUrl, url, type)).asElement();
      } catch (error) {
        throw new Error(`Loading script from ${url} failed`);
      }
    }

    if (path !== null) {
      let contents = await readFileAsync(path, 'utf8');
      contents += '//# sourceURL=' + path.replace(/\n/g, '');
      const context = await this._mainContext();
      return (await context.evaluateHandle(addScriptContent, contents, type)).asElement();
    }

    if (content !== null) {
      const context = await this._mainContext();
      return (await context.evaluateHandle(addScriptContent, content, type)).asElement();
    }

    throw new Error('Provide an object with a `url`, `path` or `content` property');

    async function addScriptUrl(url: string, type: string): Promise<HTMLElement> {
      const script = document.createElement('script');
      script.src = url;
      if (type)
        script.type = type;
      const promise = new Promise((res, rej) => {
        script.onload = res;
        script.onerror = rej;
      });
      document.head.appendChild(script);
      await promise;
      return script;
    }

    function addScriptContent(content: string, type: string = 'text/javascript'): HTMLElement {
      const script = document.createElement('script');
      script.type = type;
      script.text = content;
      let error = null;
      script.onerror = e => error = e;
      document.head.appendChild(script);
      if (error)
        throw error;
      return script;
    }
  }

  async addStyleTag(options: { url?: string; path?: string; content?: string; }): Promise<dom.ElementHandle> {
    const {
      url = null,
      path = null,
      content = null
    } = options;
    if (url !== null) {
      try {
        const context = await this._mainContext();
        return (await context.evaluateHandle(addStyleUrl, url)).asElement();
      } catch (error) {
        throw new Error(`Loading style from ${url} failed`);
      }
    }

    if (path !== null) {
      let contents = await readFileAsync(path, 'utf8');
      contents += '/*# sourceURL=' + path.replace(/\n/g, '') + '*/';
      const context = await this._mainContext();
      return (await context.evaluateHandle(addStyleContent, contents)).asElement();
    }

    if (content !== null) {
      const context = await this._mainContext();
      return (await context.evaluateHandle(addStyleContent, content)).asElement();
    }

    throw new Error('Provide an object with a `url`, `path` or `content` property');

    async function addStyleUrl(url: string): Promise<HTMLElement> {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      const promise = new Promise((res, rej) => {
        link.onload = res;
        link.onerror = rej;
      });
      document.head.appendChild(link);
      await promise;
      return link;
    }

    async function addStyleContent(content: string): Promise<HTMLElement> {
      const style = document.createElement('style');
      style.type = 'text/css';
      style.appendChild(document.createTextNode(content));
      const promise = new Promise((res, rej) => {
        style.onload = res;
        style.onerror = rej;
      });
      document.head.appendChild(style);
      await promise;
      return style;
    }
  }

  async click(selector: string, options?: ClickOptions) {
    const context = await this._utilityContext();
    const document = await context._document();
    const handle = await document.$(selector);
    assert(handle, 'No node found for selector: ' + selector);
    await handle.click(options);
    await handle.dispose();
  }

  async dblclick(selector: string, options?: MultiClickOptions) {
    const context = await this._utilityContext();
    const document = await context._document();
    const handle = await document.$(selector);
    assert(handle, 'No node found for selector: ' + selector);
    await handle.dblclick(options);
    await handle.dispose();
  }

  async tripleclick(selector: string, options?: MultiClickOptions) {
    const context = await this._utilityContext();
    const document = await context._document();
    const handle = await document.$(selector);
    assert(handle, 'No node found for selector: ' + selector);
    await handle.tripleclick(options);
    await handle.dispose();
  }

  async fill(selector: string, value: string) {
    const context = await this._utilityContext();
    const document = await context._document();
    const handle = await document.$(selector);
    assert(handle, 'No node found for selector: ' + selector);
    await handle.fill(value);
    await handle.dispose();
  }

  async focus(selector: string) {
    const context = await this._utilityContext();
    const document = await context._document();
    const handle = await document.$(selector);
    assert(handle, 'No node found for selector: ' + selector);
    await handle.focus();
    await handle.dispose();
  }

  async hover(selector: string, options?: PointerActionOptions) {
    const context = await this._utilityContext();
    const document = await context._document();
    const handle = await document.$(selector);
    assert(handle, 'No node found for selector: ' + selector);
    await handle.hover(options);
    await handle.dispose();
  }

  async select(selector: string, ...values: (string | dom.ElementHandle | SelectOption)[]): Promise<string[]> {
    const context = await this._utilityContext();
    const document = await context._document();
    const handle = await document.$(selector);
    assert(handle, 'No node found for selector: ' + selector);
    const utilityContext = await this._utilityContext();
    const adoptedValues = await Promise.all(values.map(async value => {
      if (value instanceof dom.ElementHandle)
        return this._adoptElementHandle(value, utilityContext, false /* dispose */);
      return value;
    }));
    const result = await handle.select(...adoptedValues);
    await handle.dispose();
    return result;
  }

  async type(selector: string, text: string, options: { delay: (number | undefined); } | undefined) {
    const context = await this._utilityContext();
    const document = await context._document();
    const handle = await document.$(selector);
    assert(handle, 'No node found for selector: ' + selector);
    await handle.type(text, options);
    await handle.dispose();
  }

  waitFor(selectorOrFunctionOrTimeout: (string | number | Function), options: any = {}, ...args: any[]): Promise<js.JSHandle | null> {
    const xPathPattern = '//';

    if (helper.isString(selectorOrFunctionOrTimeout)) {
      const string = selectorOrFunctionOrTimeout as string;
      if (string.startsWith(xPathPattern))
        return this.waitForXPath(string, options) as any;
      return this.waitForSelector(string, options) as any;
    }
    if (helper.isNumber(selectorOrFunctionOrTimeout))
      return new Promise(fulfill => setTimeout(fulfill, selectorOrFunctionOrTimeout as number));
    if (typeof selectorOrFunctionOrTimeout === 'function')
      return this.waitForFunction(selectorOrFunctionOrTimeout, options, ...args);
    return Promise.reject(new Error('Unsupported target type: ' + (typeof selectorOrFunctionOrTimeout)));
  }

  async waitForSelector(selector: string, options: {
      visible?: boolean;
      hidden?: boolean;
      timeout?: number; } | undefined): Promise<dom.ElementHandle | null> {
    const params = waitForSelectorOrXPath(selector, false /* isXPath */, { timeout: this._delegate.timeoutSettings().timeout(), ...options });
    const handle = await this._scheduleWaitTask(params, this._worlds.get('utility'));
    if (!handle.asElement()) {
      await handle.dispose();
      return null;
    }
    const mainContext = await this._mainContext();
    return this._adoptElementHandle(handle.asElement(), mainContext, true /* dispose */);
  }

  async waitForXPath(xpath: string, options: {
      visible?: boolean;
      hidden?: boolean;
      timeout?: number; } | undefined): Promise<dom.ElementHandle | null> {
    const params = waitForSelectorOrXPath(xpath, true /* isXPath */, { timeout: this._delegate.timeoutSettings().timeout(), ...options });
    const handle = await this._scheduleWaitTask(params, this._worlds.get('utility'));
    if (!handle.asElement()) {
      await handle.dispose();
      return null;
    }
    const mainContext = await this._mainContext();
    return this._adoptElementHandle(handle.asElement(), mainContext, true /* dispose */);
  }

  waitForFunction(
    pageFunction: Function | string,
    options: { polling?: string | number; timeout?: number; } = {},
    ...args): Promise<js.JSHandle> {
    const {
      polling = 'raf',
      timeout = this._delegate.timeoutSettings().timeout(),
    } = options;
    const params: WaitTaskParams = {
      predicateBody: pageFunction,
      title: 'function',
      polling,
      timeout,
      args
    };
    return this._scheduleWaitTask(params, this._worlds.get('main'));
  }

  async title(): Promise<string> {
    const context = await this._utilityContext();
    return context.evaluate(() => document.title);
  }

  _navigated(url: string, name: string) {
    this._url = url;
    this._name = name;
  }

  _detach() {
    this._detached = true;
    for (const world of this._worlds.values()) {
      for (const waitTask of world.waitTasks)
        waitTask.terminate(new Error('waitForFunction failed: frame got detached.'));
    }
    if (this._parentFrame)
      this._parentFrame._childFrames.delete(this);
    this._parentFrame = null;
  }

  private _scheduleWaitTask(params: WaitTaskParams, world: World): Promise<js.JSHandle> {
    const task = new WaitTask(params, () => world.waitTasks.delete(task));
    world.waitTasks.add(task);
    if (world.context)
      task.rerun(world.context);
    return task.promise;
  }

  private _setContext(worldType: WorldType, context: js.ExecutionContext | null) {
    const world = this._worlds.get(worldType);
    world.context = context;
    if (context) {
      world.contextResolveCallback.call(null, context);
      for (const waitTask of world.waitTasks)
        waitTask.rerun(context);
    } else {
      world.contextPromise = new Promise(fulfill => {
        world.contextResolveCallback = fulfill;
      });
    }
  }

  _contextCreated(worldType: WorldType, context: js.ExecutionContext) {
    const world = this._worlds.get(worldType);
    // In case of multiple sessions to the same target, there's a race between
    // connections so we might end up creating multiple isolated worlds.
    // We can use either.
    if (!world.context)
      this._setContext(worldType, context);
  }

  _contextDestroyed(context: js.ExecutionContext) {
    for (const [worldType, world] of this._worlds) {
      if (world.context === context)
        this._setContext(worldType, null);
    }
  }

  private async _adoptElementHandle(elementHandle: dom.ElementHandle, context: js.ExecutionContext, dispose: boolean): Promise<dom.ElementHandle> {
    if (elementHandle.executionContext() === context)
      return elementHandle;
    const handle = this._delegate.adoptElementHandle(elementHandle, context);
    if (dispose)
      await elementHandle.dispose();
    return handle;
  }
}
