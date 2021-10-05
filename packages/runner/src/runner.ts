import { resolve } from 'path';
import { types, promisify } from 'util';
import { performance } from 'perf_hooks';

import 'reflect-metadata';
import glob = require('glob');

import type {
  Test, TestResult,
  FileResult,
  ClassResult,
  RunnerLike,
  ClassTest,
  Internal,
  FileTest,
} from '@magiqan/types';
import {
  METADATA_CLASS_KEY,
  METADATA_INSTANCE_KEY,
} from '@magiqan/constants';
import { events } from '@magiqan/events';

import delay from './delay';

const globAsync = promisify(glob);
const defaultTimeout = 5000;

export class Runner implements RunnerLike {
  static timeout = defaultTimeout;
  constructor(readonly cwd = __dirname) { }
  private _allPaths: string[] = [];
  private _hasInitBefore = false;
  private _init(): void | Promise<void> {
    events.emit('runnerInit', this);
  }

  setDefaultTimeout(timeout: number) {
    Runner.timeout = timeout;
  }

  resetTimeout() {
    Runner.timeout = defaultTimeout;
  }

  addFile(filePath: string) {
    this._appendFile(filePath);
  }
  async addGlob(globPattern: string) {
    const paths = await globAsync(globPattern);
    paths.forEach((f) => this._appendFile(f));
  }
  addFiles(filePaths: string[]) {
    filePaths.forEach(this._appendFile)
  }

  private _appendFile(file: string) {
    this._allPaths.push(resolve(this.cwd, file));
  }
  async run(): Promise<(FileResult | undefined)[]> {
    if (!this._hasInitBefore) {
      this._init();
    }
    if (this._allPaths.length === 0) {
      return [];
    }
    const results = await Promise.all(this._allPaths.map(f => this.runFile(f)));
    return results;
  }

  async runFile(filePath: string): Promise<FileResult | undefined> {
    if (!this._hasInitBefore) {
      this._init();
    }
    const resolved = resolve(__dirname, filePath);
    const imported: Record<string, unknown> = await import(resolved);
    const fileTest: FileTest = {
      classes: [],
      path: resolved,
    };
    events.emit('runFile', this, fileTest);

    const fileResult: FileResult = {
      path: resolved,
      results: [],
      result: 'pending',
    };
    const classTests: (ClassTest | undefined)[] = await Promise.all(Object.entries(imported).map(async ([, value]) => {
      if (
        typeof value === 'function' &&
        Reflect.hasMetadata(METADATA_CLASS_KEY, value.prototype)
      ) {
        return Reflect.getMetadata(METADATA_CLASS_KEY, value.prototype) as ClassTest;
      } else {
        return;
      }
    }));
    const findedTests = classTests.filter(t => t !== undefined) as ClassTest[];
    if (!findedTests || !Array.isArray(findedTests) || findedTests.length === 0) {
      console.log('No test classes maked with @testable');
      return;
    }
    fileTest.classes.push(...findedTests);

    events.emit('fileParsed', this, fileTest);

    const results: ClassResult[] = await Promise.all(fileTest.classes.map(async cls => {
      if (cls.skip) {
        // TODO: collect all tests maked as `@test` and add to results
        return { result: 'skipped', results: [], ctor: cls.ctor, name: cls.name, } as ClassResult;
      }
      const classResult = await this.runClass(cls.ctor);
      return classResult;
    }));

    fileResult.results.push(...results);
    const isEveryTestClassPassed = results.every(r => r.result === 'passed');
    const isEveryTestClassSkipped = results.every(r => r.result === 'skipped');
    const isSomeTestClassFailed = results.some(r => r.result === 'failed');
    const isSomeTestClassBroken = results.some(r => r.result === 'broken');
    if (isSomeTestClassFailed) {
      fileResult.result = 'failed';
    } else if (isEveryTestClassPassed) {
      fileResult.result = 'passed';
    } else if (isSomeTestClassBroken) {
      fileResult.result = 'broken';
    } else if (isEveryTestClassSkipped) {
      fileResult.result = 'skipped';
    } else {
      fileResult.result = 'broken';
    }
    events.emit('fileResult', this, fileResult);
    return fileResult;
  }
  /**
   * Run class which marked `@testable` decorator
   *
   * @template R
   * @param {Ctor<R>} ctor
   * @return {*}  {Promise<ClassResult>}
   * @memberof Runner
   */
  async runClass<R>(ctor: Internal.Ctor<R>): Promise<ClassResult> {
    if (!this._hasInitBefore) {
      this._init();
    }
    const instance = this._constructInstanceIfNeeded(ctor);
    const result: ClassResult = {
      ctor,
      instance,
      name: ctor.name,
      result: 'pending',
      results: [],
      start: performance.now(),
    };
    const classTest: ClassTest = {
      ctor,
      hooks: [],
      name: ctor.name,
      tests: [],
    };
    const classMetaValue: ClassTest = Reflect.getMetadata(METADATA_CLASS_KEY, ctor.prototype);
    const mergedTest: ClassTest = { ...classTest, ...classMetaValue };
    Reflect.defineMetadata(METADATA_CLASS_KEY, mergedTest, ctor.prototype)
    events.emit('runClass', this, mergedTest);
    const beforeAllResults = await this._runHooks(mergedTest, 'beforeAll');
    const results = await Promise.all(mergedTest.tests.map(async test => {
      return await this.runClassTest(ctor, test.name as keyof Internal.Ctor);
    }));
    const afterAllResults = await this._runHooks(mergedTest, 'afterAll');
    result.stop = performance.now();
    result.results.push(...[...beforeAllResults, ...results, ...afterAllResults]);

    const isAnyHookFailed =
      afterAllResults.some(r => r.result === 'failed')
      || beforeAllResults.some(r => r.result === 'failed')
      || results.some(r => r.hooks?.some(r => r.result === 'failed'));
    const isAllTestsPassedExcludeSkipped = results.filter(r => r.result !== 'skipped').every(r => r.result === 'passed');

    const isAllTestsSkipped = results.every(r => r.result === 'skipped');
    if (isAllTestsPassedExcludeSkipped) {
      result.result = 'passed';
    } else if (isAnyHookFailed) {
      result.result = 'broken';
    } else if (isAllTestsSkipped) {
      result.result = 'skipped';
    } else {
      result.result = 'broken';
    }
    events.emit('classResult', this, mergedTest, result);
    return result;
  }

  /**
   * Run class test which marked `@test` with `each` hooks
   *
   * @template Cls
   * @template M
   * @param {Cls} ctor
   * @param {ReturnType<M> extends any ? M : never} method
   * @return {*}  {Promise<TestResult>}
   * @memberof Runner
   */
  async runClassTest<
    Cls extends Internal.Ctor,
    // @ts-ignore
    M extends keyof Cls['prototype']
  >(ctor: Cls, method: M): Promise<TestResult> {
    if (!this._hasInitBefore) {
      this._init();
    }
    const instance = this._constructInstanceIfNeeded(ctor) as Record<string, Function>;

    const classTest: ClassTest = Reflect.getMetadata(METADATA_CLASS_KEY, ctor.prototype);
    const findedTest = classTest.tests.find(t => t.name === method);
    if (findedTest === undefined) {
      throw new Error(`${ctor.name} is no marked with @test() decorator`);
    }
    const result: TestResult = {
      kind: 'test',
      name: findedTest.name,
      start: performance.now(),
      isHook: false,
      result: 'pending',
    };

    events.emit('classMethod', this, classTest, findedTest);

    const isHaveHooks = !!findedTest.hooks && Array.isArray(findedTest.hooks) && findedTest.hooks.length !== 0;

    if (findedTest.skip) {
      // skip. do not run hooks for selected tests
      const skippedResult: TestResult = {
        ...findedTest,
        result: 'skipped',
        hooks: [],
      };
      if (isHaveHooks) {
        skippedResult.hooks = [
          ...findedTest.hooks!.filter(h => h.kind === 'beforeEach').map(h => ({ ...h, result: 'skipped', }) as TestResult),
          ...findedTest.hooks!.filter(h => h.kind === 'afterEach').map(h => ({ ...h, result: 'skipped', }) as TestResult)
        ]
      }
      events.emit('classMethodResult', this, classTest, findedTest, skippedResult);
      return skippedResult;
    }

    // have hooks to run
    if (isHaveHooks) {
      const definedBeforeEachHook = findedTest.hooks!
        .filter(h => !h.skip && h.kind === 'beforeEach');

      const beforeEachResults = await Promise.all(definedBeforeEachHook.map(async hook => {
        events.emit('classEachHook', this, classTest, findedTest, hook);
        const result = await this._runFunction.call(instance, hook.fn, []);
        events.emit('classEachHookResult', this, classTest, findedTest, hook, result);

        return result;
      }));
      result.hooks?.push(...beforeEachResults)
    }

    const testRunResult = await this._runFunction.call(instance, findedTest.fn, findedTest.data);

    result.error = testRunResult.error;
    result.result = testRunResult.result;

    if (result.result === 'failed' && types.isNativeError(result.error)) {
      result.error = result.error.stack;
    } else {
      delete result.error;
    }

    // have hooks to run
    if (isHaveHooks) {
      const definedAfterEachHook = findedTest.hooks!
        .filter(h => !h.skip && h.kind === 'afterEach');
      const afterEachResults = await Promise.all(definedAfterEachHook.map(async hook => {
        events.emit('classEachHook', this, classTest, findedTest, hook);
        const result = await this._runFunction.call(instance, hook.fn, []);
        events.emit('classEachHookResult', this, classTest, findedTest, hook, result);
        // const attachments: { name: string, attachment: Attachment }[] = Reflect.getMetadata(METADATA_ATTACHMENT_KEY, instance as object);
        return result;
      }));
      result.hooks?.push(...afterEachResults)
    }

    result.stop = performance.now();

    if (isHaveHooks) {
      const isSomeHookFailed = result.hooks!.some(h => h.result === 'failed');
      if (isSomeHookFailed) {
        result.result = 'broken';
      }
    }

    events.emit('classMethodResult', this, classTest, findedTest, result);

    return result;
  }

  private async _runHooks(classTest: ClassTest, kind: Test['kind']): Promise<TestResult[]> {
    const isntance = this._constructInstanceIfNeeded(classTest.ctor);
    const classMetaValue: ClassTest = Reflect.getMetadata(METADATA_CLASS_KEY, classTest.ctor.prototype);
    const hooks = classMetaValue.hooks.filter(h => h.kind === kind);
    const skippedHooks = hooks.filter(h => h.skip);
    const runnedHooks = hooks.filter(h => !h.skip);
    const result: TestResult[] = [];
    skippedHooks.forEach(k => result.push({ result: 'skipped', name: k.name, isHook: true, kind: k.kind }));
    const hookRunResult: TestResult[] = await Promise.all(runnedHooks.map(async h => {
      events.emit('classHook', this, classTest, h);
      const result = await this._runFunction.call(isntance, h.fn!);
      const hookResult = { ...result, isHook: true, name: h.name, kind: h.kind, stop: performance.now(), };
      events.emit('classMethodResult', this, classTest, h, hookResult);
      // const attachments: { name: string, attachment: Attachment }[] = Reflect.getMetadata(METADATA_ATTACHMENT_KEY, isntance as object)
      return { ...hookResult, name: h.name };
    }));
    result.push(...hookRunResult);
    return result;
  }
  private _runFunction(this: any, fn: Function, ...args: any[]): Promise<TestResult> {
    const result = { start: performance.now(), result: 'pending', attachments: [], labels: [], name: '', } as TestResult;
    return Promise.race<TestResult>([
      Reflect.apply(fn, this || null, args),
      delay(Runner.timeout),
    ]).then(() => {
      return { ...result, result: 'passed', name: fn.name, stop: performance.now() } as TestResult;
    }).catch(error => {
      if (types.isNativeError(error) || typeof error === 'string') {
        console.error(error);
        return { ...result, result: 'failed', error, name: fn.name, stop: performance.now() };
      }
      return { ...result, result: 'failed', error: new Error('unknown error occured'), name: fn.name, isHook: false, stop: performance.now(), };
    });
  }
  private _constructInstanceIfNeeded<R>(ctor: Internal.Ctor<R>): R {
    const metaInstance = Reflect.getMetadata(METADATA_INSTANCE_KEY, ctor.prototype);
    const classTest: ClassTest = Reflect.getMetadata(METADATA_CLASS_KEY, ctor.prototype)
    if (!metaInstance) {
      const instance = Reflect.construct(ctor, []);
      events.emit('classConstructor', this, classTest, instance);
      return instance;
    }
    return metaInstance;
  }
}