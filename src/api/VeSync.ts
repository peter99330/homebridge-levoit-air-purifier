import axios, { AxiosInstance } from 'axios';
import { Logger } from 'homebridge';
import AsyncLock from 'async-lock';
import crypto from 'crypto';

import deviceTypes, { humidifierDeviceTypes } from './deviceTypes';
import VeSyncHumidifier from './VeSyncHumidifier';
import { VeSyncGeneric } from './VeSyncGeneric';
import DebugMode from '../debugMode';
import VeSyncFan from './VeSyncFan';

const US_HOST = 'https://smartapi.vesync.com';
const EU_HOST = 'https://smartapi.vesync.eu';
const ACCOUNT_HOST = 'https://accountapi.vesync.com';
const CROSS_REGION_CODE = -11260022;

function initialHostForCountry(cc: string): string {
  const upper = cc.toUpperCase();
  if (['US', 'CA', 'MX', 'JP'].includes(upper)) return US_HOST;
  return EU_HOST;
}

function pickCountryCodeForRetry(step2Resp: any, originalCC: string): string {
  const region = (step2Resp?.result?.currentRegion || step2Resp?.currentRegion || '').toUpperCase();
  if (region === 'US') return 'US';
  const serverCC = step2Resp?.result?.countryCode || step2Resp?.countryCode;
  const cc = (serverCC || originalCC || '').toUpperCase();
  return /^[A-Z]{2}$/.test(cc) ? cc : (/^[A-Z]{2}$/.test(originalCC.toUpperCase()) ? originalCC.toUpperCase() : 'US');
}

function regionToHost(region?: string): string {
  if (typeof region === 'string' && region.toUpperCase() === 'EU') return EU_HOST;
  return US_HOST;
}

export enum BypassMethod {
  STATUS = 'getPurifierStatus',
  MODE = 'setPurifierMode',
  NIGHT = 'setNightLight',
  DISPLAY = 'setDisplay',
  LOCK = 'setChildLock',
  SWITCH = 'setSwitch',
  SPEED = 'setLevel'
}

export enum HumidifierBypassMethod {
  HUMIDITY = 'setTargetHumidity',
  STATUS = 'getHumidifierStatus',
  MIST_LEVEL = 'setVirtualLevel',
  MODE = 'setHumidityMode',
  DISPLAY = 'setDisplay',
  SWITCH = 'setSwitch',
  LEVEL = 'setLevel',
}

const lock = new AsyncLock();

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default class VeSync {
  private api?: AxiosInstance;
  private accountId?: string;
  private token?: string;

  private readonly VERSION = '1.3.1';
  private readonly AGENT = `VeSync/VeSync 3.0.51(F5321;HomeBridge-VeSync ${this.VERSION})`;
  private readonly TIMEZONE = 'America/New_York';
  private readonly OS = 'HomeBridge-VeSync';
  private readonly LANG = 'en';

  private baseURL: string;

  constructor(
    private readonly email: string,
    private readonly password: string,
    private readonly region: string,
    public readonly debugMode: DebugMode,
    public readonly log: Logger
  ) {
    const cc = (region || 'US').toUpperCase();
    this.baseURL = initialHostForCountry(cc);
    this.debugMode.debug?.('[CONFIG]', `countryCode=${cc}, initialBaseURL=${this.baseURL}`);
  }

  private AXIOS_OPTIONS() {
    return {
      baseURL: this.baseURL,
      timeout: 30000
    };
  }

  private ACCOUNT_AXIOS_OPTIONS() {
    return {
      baseURL: ACCOUNT_HOST,
      timeout: 30000,
      headers: {
        'content-type': 'application/json',
        'accept-language': this.LANG,
        'user-agent': this.AGENT,
        appversion: this.VERSION,
        tz: this.TIMEZONE,
      },
    };
  }

  private generateDetailBody() {
    return {
      appVersion: this.VERSION,
      phoneBrand: this.OS,
      traceId: Date.now(),
      phoneOS: this.OS
    };
  }

  private generateBody(includeAuth = false) {
    return {
      acceptLanguage: this.LANG,
      timeZone: this.TIMEZONE,
      ...(includeAuth
        ? {
          accountID: this.accountId,
          token: this.token
        }
        : {})
    };
  }

  private generateV2Body(fan: VeSyncGeneric, method: BypassMethod | HumidifierBypassMethod, data = {}) {
    return {
      method: 'bypassV2',
      debugMode: false,
      deviceRegion: fan.region,
      cid: fan.cid,
      configModule: fan.configModule,
      payload: {
        data: {
          ...data
        },
        method,
        source: 'APP'
      }
    };
  }

  public async sendCommand(
    fan: VeSyncGeneric,
    method: BypassMethod | HumidifierBypassMethod,
    body = {}
  ): Promise<boolean> {
    return lock.acquire('api-call', async () => {
      try {
        if (!this.api) {
          throw new Error('The user is not logged in!');
        }

        this.debugMode.debug(
          '[SEND COMMAND]',
          `Sending command ${method} to ${fan.name}`,
          `with (${JSON.stringify(body)})...`
        );

        const response = await this.api.put('cloud/v2/deviceManaged/bypassV2', {
          ...this.generateV2Body(fan, method, body),
          ...this.generateDetailBody(),
          ...this.generateBody(true)
        });

        if (!response?.data) {
          this.debugMode.debug(
            '[SEND COMMAND]',
            'No response data!! JSON:',
            JSON.stringify(response)
          );
        }

        const isSuccess = response?.data?.code === 0;
        if (!isSuccess) {
          this.debugMode.debug(
            '[SEND COMMAND]',
            `Failed to send command ${method} to ${fan.name}`,
            `with (${JSON.stringify(body)})!`,
            `Response: ${JSON.stringify(response)}`
          );
        }

        await delay(500);

        return isSuccess;
      } catch (error: any) {
        this.log.error(
          `Failed to send command ${method} to ${fan?.name}`,
          `Error: ${error?.message}`
        );
        return false;
      }
    });
  }

  public async getDeviceInfo(fan: VeSyncGeneric, humidifier = false): Promise<any> {
    return lock.acquire('api-call', async () => {
      try {
        if (!this.api) {
          throw new Error('The user is not logged in!');
        }

        this.debugMode.debug('[GET DEVICE INFO]', 'Getting device info...');

        const response = await this.api.post(
          'cloud/v2/deviceManaged/bypassV2',
          {
            ...this.generateV2Body(fan, humidifier ? HumidifierBypassMethod.STATUS : BypassMethod.STATUS),
            ...this.generateDetailBody(),
            ...this.generateBody(true)
          }
        );

        if (!response?.data) {
          this.debugMode.debug(
            '[GET DEVICE INFO]',
            'No response data!! JSON:',
            JSON.stringify(response)
          );
        }

        await delay(500);

        this.debugMode.debug(
          '[GET DEVICE INFO]',
          'JSON:',
          JSON.stringify(response.data)
        );

        return response.data;
      } catch (error: any) {
        this.log.error(
          `Failed to get device info for ${fan?.name}`,
          `Error: ${error?.message}`
        );

        return null;
      }
    });
  }

  public async startSession(): Promise<boolean> {
    this.debugMode.debug('[START SESSION]', 'Starting auth session...');
    const ok = await this.login();
    if (ok) setInterval(this.login.bind(this), 1000 * 60 * 55);
    return ok;
  }

  private async login(): Promise<boolean> {
    return lock.acquire('auth-call', async () => {
      if (!this.email || !this.password) {
        throw new Error('Email and password are required');
      }
      const userCountryCode = (this.region || 'US').toUpperCase();
      this.debugMode.debug('[LOGIN]', 'Step 1: authByPWDOrOTM…');
      const { authorizeCode, bizToken: initialBizToken } = await this.authByPWDOrOTM(userCountryCode);
      this.debugMode.debug('[LOGIN]', `Step 2: loginByAuthorizeCode on ${this.baseURL}…`);
      let step2Resp = await this.loginByAuthorizeCode4Vesync({
        userCountryCode,
        authorizeCode,
        host: this.baseURL,
      });
      if (step2Resp?.code === CROSS_REGION_CODE) {
        const currentRegion = step2Resp?.result?.currentRegion || step2Resp?.data?.currentRegion || step2Resp?.currentRegion;
        const crossBizToken = step2Resp?.result?.bizToken || step2Resp?.data?.bizToken || initialBizToken || null;
        const regionHost = regionToHost(currentRegion);
        const overrideCC = pickCountryCodeForRetry(step2Resp, userCountryCode);
        this.debugMode.debug('[LOGIN]', `Cross-region detected (${currentRegion}). Retrying on ${regionHost} with bizToken and userCountryCode=${overrideCC} (regionChange=last_region)…`);
        this.baseURL = regionHost;
        step2Resp = await this.loginByAuthorizeCode4Vesync({
          userCountryCode,
          bizToken: crossBizToken,
          host: this.baseURL,
          regionChange: 'last_region',
          overrideCountryCode: overrideCC,
          currentRegion,
        });
      }
      if (!step2Resp || step2Resp.code !== 0 || !step2Resp.result?.token || !step2Resp.result?.accountID) {
        this.debugMode.debug('[LOGIN] Failed final step', JSON.stringify(step2Resp));
        return false;
      }
      const { token, accountID } = step2Resp.result;
      this.debugMode.debug('[LOGIN]', 'Authentication was successful');
      this.accountId = accountID;
      this.token = token;
      this.api = axios.create({
        ...this.AXIOS_OPTIONS(),
        headers: {
          'content-type': 'application/json',
          'accept-language': this.LANG,
          accountid: this.accountId!,
          'user-agent': this.AGENT,
          appversion: this.VERSION,
          tz: this.TIMEZONE,
          tk: this.token!,
        },
      });
      this.api.interceptors.response.use(
        (resp) => resp,
        async (err) => {
          if (err?.response?.status === 401) {
            this.debugMode.debug('[AUTH]', '401 detected, re-authenticating…');
            const ok = await this.login();
            if (ok && err.config) {
              err.config.headers = err.config.headers || {};
              err.config.headers.tk = this.token!;
              err.config.headers.accountid = this.accountId!;
              return this.api!.request(err.config);
            }
          }
          throw err;
        },
      );
      return true;
    });
  }

  private async authByPWDOrOTM(userCountryCode: string): Promise<{ authorizeCode: string | null; bizToken: string | null }> {
    const pwdHashed = crypto.createHash('md5').update(this.password).digest('hex');
    const body = {
      email: this.email,
      method: 'authByPWDOrOTM',
      password: pwdHashed,
      acceptLanguage: this.LANG,
      accountID: '',
      authProtocolType: 'generic',
      clientInfo: this.OS,
      clientType: 'vesyncApp',
      clientVersion: this.VERSION,
      debugMode: false,
      osInfo: this.OS.includes('iOS') ? 'iOS' : 'Android',
      terminalId: '2' + Math.random().toString(36).substring(2, 10),
      timeZone: this.TIMEZONE,
      token: '',
      userCountryCode,
      userType: 1,
      devToken: '',
      appID: Math.random().toString(36).substring(2, 10),
      sourceAppID: Math.random().toString(36).substring(2, 10),
      ...this.generateDetailBody(),
    };
    let resp;
    try {
      resp = await axios.post(
        '/globalPlatform/api/accountAuth/v1/authByPWDOrOTM',
        body,
        this.ACCOUNT_AXIOS_OPTIONS(),
      );
    } catch (e) {
      this.debugMode.debug('[AUTH] accountapi failed, falling back to smartapi', String(e));
      resp = await axios.post(
        '/globalPlatform/api/accountAuth/v1/authByPWDOrOTM',
        body,
        this.AXIOS_OPTIONS(),
      );
    }
    if (!resp?.data || resp.data.code !== 0 || !resp.data.result) {
      this.debugMode.debug('[AUTH] Failed authByPWDOrOTM', JSON.stringify(resp?.data));
      throw new Error('VeSync authentication failed at step 1');
    }
    const { authorizeCode = null, bizToken = null } = resp.data.result;
    return { authorizeCode, bizToken };
  }

  private async loginByAuthorizeCode4Vesync(opts: {
    userCountryCode: string;
    host: string;
    authorizeCode?: string | null;
    bizToken?: string | null;
    regionChange?: 'last_region';
    overrideCountryCode?: string;
    currentRegion?: string;
  }): Promise<any> {
    const {
      userCountryCode,
      host,
      authorizeCode = null,
      bizToken = null,
      regionChange,
      overrideCountryCode,
      currentRegion,
    } = opts;
    const body: any = {
      method: 'loginByAuthorizeCode4Vesync',
      authorizeCode,
      acceptLanguage: this.LANG,
      accountID: '',
      clientInfo: this.OS,
      clientType: 'vesyncApp',
      clientVersion: this.VERSION,
      debugMode: false,
      emailSubscriptions: false,
      osInfo: this.OS.includes('iOS') ? 'iOS' : 'Android',
      terminalId: '2' + Math.random().toString(36).substring(2, 10),
      timeZone: this.TIMEZONE,
      token: '',
      userCountryCode: overrideCountryCode || userCountryCode,
      ...(regionChange ? { regionChange } : {}),
      ...(currentRegion ? { region: String(currentRegion).toUpperCase() } : {}),
      appID: Math.random().toString(36).substring(2, 10),
      sourceAppID: Math.random().toString(36).substring(2, 10),
      ...this.generateDetailBody(),
    };
    if (bizToken) {
      body.bizToken = bizToken;
      body.authorizeCode = null;
    }
    try {
      const resp = await axios.post(
        '/user/api/accountManage/v1/loginByAuthorizeCode4Vesync',
        body,
        { baseURL: host, timeout: 30000 },
      );
      return resp?.data;
    } catch (e) {
      this.debugMode.debug('[LOGIN STEP 2] network error', String(e));
      return undefined;
    }
  }

  public async getDevices() {
    return lock.acquire<{
      purifiers: VeSyncFan[];
      humidifiers: VeSyncHumidifier[];
    }>('api-call', async () => {
      try {
        if (!this.api) {
          throw new Error('The user is not logged in!');
        }

        const response = await this.api.post('cloud/v2/deviceManaged/devices', {
          method: 'devices',
          pageNo: 1,
          pageSize: 1000,
          ...this.generateDetailBody(),
          ...this.generateBody(true)
        });

        if (!response?.data) {
          this.debugMode.debug(
            '[GET DEVICES]',
            'No response data!! JSON:',
            JSON.stringify(response)
          );

          return {
            purifiers: [],
            humidifiers: []
          };
        }

        if (!Array.isArray(response.data?.result?.list)) {
          this.debugMode.debug(
            '[GET DEVICES]',
            'No list found!! JSON:',
            JSON.stringify(response.data)
          );

          return {
            purifiers: [],
            humidifiers: []
          };
        }

        const { list } = response.data.result ?? { list: [] };

        this.debugMode.debug(
          '[GET DEVICES]',
          'Device List -> JSON:',
          JSON.stringify(list)
        );


        let purifiers = list
          .filter(
            ({ deviceType, type, extension }) =>
              !!deviceTypes.find(({ isValid }) => isValid(deviceType)) &&
              type === 'wifi-air' &&
              !!extension?.fanSpeedLevel
          )
          .map(VeSyncFan.fromResponse(this));

          // Newer Vital purifiers
          purifiers = purifiers.concat(list
          .filter(
            ({ deviceType, type, deviceProp }) =>
              !!deviceTypes.find(({ isValid }) => isValid(deviceType)) &&
              type === 'wifi-air' &&
              !!deviceProp
          )
          .map((fan: any) => ({ ...fan, extension: { ...fan.deviceProp, airQualityLevel: fan.deviceProp.AQLevel, mode: fan.deviceProp.workMode } }))
          .map(VeSyncFan.fromResponse(this)));

        const humidifiers = list
          .filter(
            ({ deviceType, type, extension }) =>
              !!humidifierDeviceTypes.find(({ isValid }) => isValid(deviceType)) &&
              type === 'wifi-air' &&
              !extension
          )
          .map(VeSyncHumidifier.fromResponse(this));

        await delay(1500);

        return {
          purifiers,
          humidifiers
        };
      } catch (error: any) {
        this.log.error('Failed to get devices', `Error: ${error?.message}`);
        return {
          purifiers: [],
          humidifiers: []
        };
      }
    });
  }
}
