import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, PuppeteerLaunchOptions } from 'puppeteer';
import { appConfig } from '../config/appConfig';

puppeteer.use(StealthPlugin());

const defaultLaunchArgs = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-blink-features=AutomationControlled',
];

export const createBrowser = async (): Promise<Browser> => {
  const options: PuppeteerLaunchOptions = {
    headless: appConfig.headless,
    slowMo: appConfig.slowMo,
    args: defaultLaunchArgs,
    defaultViewport: {
      width: 1280 + Math.floor(Math.random() * 200),
      height: 720 + Math.floor(Math.random() * 200),
    },
  };

  return puppeteer.launch(options);
};
