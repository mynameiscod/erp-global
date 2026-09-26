import { existsSync } from 'node:fs';
import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import puppeteer, { type Browser, type PDFOptions } from 'puppeteer-core';

/** Where Chromium usually is, when CHROMIUM_PATH is not set. */
const CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export function findChromium(): string | undefined {
  const configured = process.env.CHROMIUM_PATH;
  if (configured) return configured;
  return CANDIDATES.find((p) => existsSync(p));
}

export interface PdfPage {
  /** Paper: a named size, or a width in mm with the height of the content (receipts). */
  size: { format: 'A4' | 'A5' | 'Letter' | 'Legal'; landscape: boolean } | { widthMm: number };
  marginMm: number;
  /** Chromium footer template (page numbers); empty for none. */
  footerTemplate?: string;
}

const RENDER_TIMEOUT_MS = 30_000;

/**
 * Turns HTML into PDF with one headless Chromium. Scripts are off and every network
 * request is refused, so a template can only show what is in the HTML itself.
 * Renders are queued (a few at a time) and the browser restarts after a number of
 * renders to keep memory steady.
 */
@Injectable()
export class PdfEngine implements OnApplicationShutdown {
  private browser?: Promise<Browser>;
  private renders = 0;
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly concurrency = Number(process.env.RENDER_CONCURRENCY ?? 2);
  private readonly recycleAfter = Number(process.env.BROWSER_RECYCLE_AFTER ?? 200);

  constructor(private readonly log: PinoLogger) {}

  private launch(): Promise<Browser> {
    const executablePath = findChromium();
    if (!executablePath) {
      throw new Error('Chromium not found. Set CHROMIUM_PATH to the browser executable.');
    }
    const p = puppeteer.launch({
      executablePath,
      headless: true,
      args: [
        // The service runs as an unprivileged user in a container, where Chromium's own
        // sandbox cannot start; pages here have no scripts and no network.
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--no-first-run',
        '--font-render-hinting=none',
      ],
    });
    p.then((b) =>
      b.on('disconnected', () => {
        if (this.browser === p) this.browser = undefined;
      }),
    ).catch(() => {
      if (this.browser === p) this.browser = undefined;
    });
    return p;
  }

  private async acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
  }

  private release(): void {
    this.active--;
    this.waiting.shift()?.();
  }

  async render(html: string, page: PdfPage): Promise<Buffer> {
    await this.acquire();
    try {
      if (this.renders >= this.recycleAfter && this.active === 1 && this.browser) {
        const old = this.browser;
        this.browser = undefined;
        this.renders = 0;
        await (await old).close().catch(() => undefined);
      }
      this.browser ??= this.launch();
      const browser = await this.browser;
      this.renders++;
      const tab = await browser.newPage();
      try {
        await tab.setJavaScriptEnabled(false);
        await tab.setRequestInterception(true);
        tab.on('request', (req) => {
          const url = req.url();
          if (url.startsWith('data:') || url === 'about:blank') void req.continue();
          else void req.abort('blockedbyclient');
        });
        await tab.setContent(html, { waitUntil: 'load', timeout: RENDER_TIMEOUT_MS });
        const options: PDFOptions = {
          printBackground: true,
          timeout: RENDER_TIMEOUT_MS,
          margin: {
            top: `${page.marginMm}mm`,
            right: `${page.marginMm}mm`,
            bottom: `${page.marginMm + (page.footerTemplate ? 6 : 0)}mm`,
            left: `${page.marginMm}mm`,
          },
          displayHeaderFooter: !!page.footerTemplate,
          headerTemplate: '<span></span>',
          footerTemplate: page.footerTemplate || '<span></span>',
        };
        if ('widthMm' in page.size) {
          await tab.setViewport({
            width: Math.round((page.size.widthMm * 96) / 25.4),
            height: 100,
          });
          // Receipts: as long as the content. The box model comes from the DOM, not scripts.
          const box = await ((await tab.$('.doc')) ?? (await tab.$('body')))?.boxModel();
          const heightPx = box ? box.height + 1 : 800;
          options.width = `${page.size.widthMm}mm`;
          options.height = `${Math.ceil((heightPx * 25.4) / 96) + page.marginMm * 2 + 2}mm`;
        } else {
          options.format = page.size.format;
          options.landscape = page.size.landscape;
        }
        return Buffer.from(await tab.pdf(options));
      } finally {
        await tab.close().catch(() => undefined);
      }
    } catch (e) {
      this.log.error({ err: e }, 'PDF render failed');
      // A broken browser is replaced on the next render.
      const b = this.browser;
      this.browser = undefined;
      if (b) await (await b.catch(() => undefined))?.close().catch(() => undefined);
      throw e;
    } finally {
      this.release();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    const b = this.browser;
    this.browser = undefined;
    if (b) await (await b.catch(() => undefined))?.close().catch(() => undefined);
  }
}
