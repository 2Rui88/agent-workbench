import { requireHealthyServices } from '../preflight.js';
import type { HealthCheck } from '../preflight.js';

export interface BrowserResource {targetId:string;contextId?:string;}
export interface BrowserAssertion {selector:string;state:'visible'|'hidden'|'text';text?:string;}
export interface OwnedBrowserPage { resource?:BrowserResource; assert?(checks:BrowserAssertion[]):Promise<void>; goto(url: string): Promise<unknown>; close(): Promise<void>; }
export interface BrowserDriver { createOwnPage(): Promise<OwnedBrowserPage>; }
export interface BrowserRunInput { healthChecks: HealthCheck[]; driver: BrowserDriver; url: string; assertions?:BrowserAssertion[];afterNavigation?:(resource:BrowserResource|undefined)=>Promise<void>;onCreated?:(resource:BrowserResource)=>void;onClosed?:(resource:BrowserResource)=>void; }

export async function runBrowserRequest(input: BrowserRunInput): Promise<{ title: string }> {
  await requireHealthyServices(input.healthChecks);
  const page = await input.driver.createOwnPage();
  try {
    if(page.resource)input.onCreated?.(page.resource);
    const result = await page.goto(input.url);
    await input.afterNavigation?.(page.resource);
    if(input.assertions?.length){if(!page.assert)throw new Error('Driver has no assertion support.');await page.assert(input.assertions);}
    return typeof result === 'object' && result !== null && 'title' in result
      ? { title: String((result as { title: unknown }).title) }
      : { title: '' };
  } finally {
    await page.close();
    if(page.resource)input.onClosed?.(page.resource);
  }
}
