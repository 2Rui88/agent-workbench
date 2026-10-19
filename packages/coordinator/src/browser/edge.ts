import { strict as assert } from 'node:assert';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import type { BrowserDriver, OwnedBrowserPage } from './runner.js';

export function validateEdgeEndpoint(endpoint: string): URL {
  const url = new URL(endpoint);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol) || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Edge CDP endpoint must use an explicit loopback HTTP address.');
  }
  return url;
}

export interface EdgeConnection extends BrowserDriver { disconnect(): Promise<void>; browser: Browser; inspectResources(targetIds:string[]):Promise<string[]>; }

export async function connectExistingEdge(endpoint: string, approvedLoginContext?: BrowserContext): Promise<EdgeConnection> {
  const url = validateEdgeEndpoint(endpoint);
  const response = await fetch(new URL('/json/version', url),{signal:AbortSignal.timeout(5000),redirect:'error'});
  if (!response.ok) throw new Error(`Edge CDP version endpoint returned HTTP ${response.status}.`);
  const version = await response.json() as { Browser?: string };
  if (!version.Browser?.startsWith('Edg/')) throw new Error('CDP endpoint does not identify Microsoft Edge.');

  const browser = await chromium.connectOverCDP(url.origin,{timeout:10000,noDefaults:true});
  if (approvedLoginContext && !browser.contexts().includes(approvedLoginContext)) {
    await browser.close();
    throw new Error('The approved login context is not attached to this Edge connection.');
  }

  return {
    browser,
    async createOwnPage(): Promise<OwnedBrowserPage> {
      const ownsContext = approvedLoginContext === undefined;
      const context = approvedLoginContext ?? await browser.newContext();
      let page;
      try {page=await context.newPage();}catch(error){if(ownsContext)await context.close();throw error;}
      let resource;
      try{const session=await context.newCDPSession(page);const {targetInfo}=await session.send('Target.getTargetInfo');resource={targetId:targetInfo.targetId,...(targetInfo.browserContextId?{contextId:targetInfo.browserContextId}:{})};await session.detach();}catch(error){await page.close();if(ownsContext)await context.close();throw error;}
      return {
        resource,
        async assert(checks){for(const check of checks){const locator=page.locator(check.selector);if(check.state==='text'){await locator.waitFor({state:'visible',timeout:5000});assert.equal(await locator.textContent(),check.text);}else await locator.waitFor({state:check.state,timeout:5000});}},
        async goto(targetUrl: string) {
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
          return { title: await page.title() };
        },
        async close() {
          await page.close();
          if (ownsContext) await context.close();
        }
      };
    },
    async inspectResources(targetIds){const session=await browser.newBrowserCDPSession();try{const {targetInfos}=await session.send('Target.getTargets');return targetInfos.filter((target)=>targetIds.includes(target.targetId)).map((target)=>target.targetId);}finally{await session.detach();}},
    async disconnect() { await browser.close(); }
  };
}
