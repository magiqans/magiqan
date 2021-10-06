import 'reflect-metadata';

import { metadata } from '@magiqan/constants';
import events from '@magiqan/events';
import type { ClassTest, Hook, Test } from '@magiqan/types';

export function defineInstance(instance: any, target: any) {
  Reflect.defineMetadata(metadata.INSTANCE_KEY, instance, target.prototype);
}

export function defineClassMetadata(ctor: any, metadataValue: Record<string, unknown>) {
  const metaClass: ClassTest = Reflect.getMetadata(metadata.CLASS_KEY, ctor);
  metaClass.metadata = { ...metaClass.metadata, ...metadataValue };
  events.emit('classMetadata', metaClass, metadataValue);
  Reflect.defineMetadata(metadata.CLASS_KEY, metaClass, ctor.prototype);
}

export function defineClassMethodMetadata(ctor: any, method: string, metadataValue: Record<string, unknown>) {
  const metaClass: ClassTest = Reflect.getMetadata(metadata.CLASS_KEY, ctor.prototype);
  const metaHooks: Hook[] = Reflect.getMetadata(metadata.HOOK_KEY, ctor.prototype);
  const metaTests: Test[] = Reflect.getMetadata(metadata.TEST_KEY, ctor.prototype);

  const findedHookIndex = metaHooks.findIndex(h => h.name === method);
  const findedTestIndex = metaTests.findIndex(h => h.name === method);
  if (Number.isInteger(findedHookIndex) && findedHookIndex >= 0) {
    metaHooks[findedHookIndex].metadata = { ...metaHooks[findedHookIndex].metadata, ...metadataValue };
    metaClass.hooks = metaHooks;
    events.emit('classHookMetadata', metaClass, metaHooks[findedHookIndex], metadataValue);
    Reflect.defineMetadata(metadata.HOOK_KEY, metaHooks, ctor.prototype);
  }

  if (Number.isInteger(findedTestIndex) && findedTestIndex >= 0) {
    metaTests[findedTestIndex].metadata = { ...metaTests[findedTestIndex].metadata, ...metadataValue };
    metaClass.tests = metaTests;
    events.emit('classMethodMetadata', metaClass, metaTests[findedTestIndex], metadataValue);
    Reflect.defineMetadata(metadata.TEST_KEY, metaTests, ctor.prototype);
  }

  Reflect.defineMetadata(metadata.CLASS_KEY, metaClass, ctor.prototype);
}