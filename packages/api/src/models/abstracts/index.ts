import { Database } from '@api/db/index';
import MangasDB from '@api/db/mangas';
import SettingsDB from '@api/db/settings';
import type { uuid } from '@api/db/uuids';
import UUID from '@api/db/uuids';
import type { MirrorConstructor } from '@api/models/types/constructor';
import type { MangaPage } from '@api/models/types/manga';
import type { SearchResult } from '@api/models/types/search';
import type { mirrorInfo } from '@api/models/types/shared';
import Scheduler from '@api/server/scheduler';
import type { socketInstance } from '@api/server/types';
import { crawler } from '@api/utils/crawler';
import { FileServer } from '@api/utils/fileserv';
import type { ClusterJob } from '@api/utils/types/crawler';
import type { mirrorsLangsType } from '@i18n/index';
import type { AxiosInstance, AxiosRequestConfig } from 'axios';
import axios, { AxiosError } from 'axios';
import type { AnyNode, CheerioAPI, CheerioOptions } from 'cheerio';
import { load } from 'cheerio';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { env } from 'process';

/**
 * The default mirror class
 *
 * All mirror classes should extend this class
 * @template T Mirror specific options
 * @example
 * class myMirror extends Mirror<{ lowres: boolean }> {}
 * // if mirror has no options use undefined
 * class myMirror extends Mirror<undefined> {}
 */
export default class Mirror<T extends Record<string, unknown> = Record<string, unknown>>  {
  #concurrency = 0;
  protected crawler = crawler;
  #icon;
  /** mirror's implementation version */
  version: number;
  /** is the mirror dead */
  isDead: boolean;
  /**
   * does the mirror treats different languages for the same manga as different entries
   * @default true
   * @example
   * ```js
   * // multipleLangsOnSameEntry = false
   * manga_from_mangadex = { title: 'A', url: `/manga/xyz`, langs: ['en', 'jp'] }
   *
   * // multipleLangsOnSameEntry = true
   * manga_from_tachidesk = { title: 'B', url: `/manga/yz`, langs: ['en'] }
   * manga_from_tachidesk2 = { title: 'B', url: `/manga/xyz`, langs: ['jp'] }
   * ```
   */
  entryLanguageHasItsOwnURL = true;
  /** slug name */
  name: string;
  /** full name */
  displayName: string;
  /**
   * hostname without ending slash
   * @example 'https://www.mirror.com'
   */
  host: string;
  /** alternative hostnames were the site can be reached */
  althost?: string[];
  /**
   * Languages supported by the mirror
   *
   * ISO 639-1 codes
   */
  langs: mirrorsLangsType[];
  /** Meta information */
  meta: {
    /**
     * quality of scans
     *
     * Number between 0 and 1
     */
    quality: number,
    /**
     * Speed of releases
     *
     * Number between 0 and 1
     */
    speed: number,
    /**
     * Mirror's popularity
     *
     * Number between 0 and 1
     */
    popularity: number,
  };
  /**
   * Request limits
   */
  #requestLimits: {
    /** time between each requests (or each batch of concurrent requests) */
    time: number,
    /** number of requests that can be sent at once */
    concurrent: number
  };


  /**
   * mirror specific options
   */
  #db: Database<MirrorConstructor<T>['options']>;
  #axios: AxiosInstance;

  constructor(opts: MirrorConstructor<T>) {
    if(typeof env.USER_DATA === 'undefined') throw Error('USER_DATA is not defined');
    this.name = opts.name;
    this.displayName = opts.displayName;
    this.host = opts.host;
    this.althost = opts.althost;
    this.langs = opts.langs;
    this.#requestLimits = opts.requestLimits;
    this.#icon = opts.icon;
    this.meta = opts.meta;
    this.version = opts.version;
    this.isDead = opts.isDead;
    if(typeof opts.entryLanguageHasItsOwnURL === 'boolean') this.entryLanguageHasItsOwnURL = opts.entryLanguageHasItsOwnURL;

    if(this.cacheEnabled) {
      const cacheDir = resolve(env.USER_DATA, '.cache', this.name);
      if(!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    }
    this.#db = new Database(resolve(env.USER_DATA, '.options', this.name+'.json'), opts.options);

    // make sure we don't have concurrent requests and wait time is forced

    this.#axios = axios.create();
    this.#axios.interceptors.request.use((conf) => {
      return new Promise((resolve) => {
        const interval = setInterval(() => {
          if (this.#concurrency < this.#requestLimits.concurrent) {
            this.#concurrency++;
            clearInterval(interval);
            resolve(conf);
          }
        }, this.#requestLimits.time);
      });
    });

    this.#axios.interceptors.response.use((response) => {
      this.#concurrency = Math.max(0, this.#concurrency - 1);
      return Promise.resolve(response);
    }, (error) => {
      this.#concurrency = Math.max(0, this.#concurrency - 1);
      return Promise.reject(error);
    });

  }

  async init() {
    const init = await this.#db.init();
    if(this.#db.data.host && typeof this.#db.data.host === 'string') {
      this.host = this.#db.data.host;
      if(this.#db.data.protocol && typeof this.#db.data.host === 'string') {
        this.host = this.#db.data.protocol + '://' + this.host;
      }
      if(this.#db.data.port && typeof this.#db.data.port === 'number') {
        this.host = this.host + ':' + this.#db.data.port;
      }
    }
    return init;
  }

  async login():Promise<boolean|void> {
    return;
  }

  public get enabled() {
    return this.#db.data.enabled && !this.isDead;
  }

  public set enabled(val:boolean) {
    this.options.enabled = val;
    this.#db.write();
  }

  public get options() {
    return this.#db.data;
  }

  public set options(opts: MirrorConstructor<T>['options']) {
    this.#db.data = { ...this.#db.data, ...opts };
    this.logger('options changed', opts);
    this.#db.write();
  }

  public get cacheEnabled() {
    return SettingsDB.getInstance().data.cache.age.enabled || SettingsDB.getInstance().data.cache.size.enabled;
  }
  /**
   * Returns the mirror icon
   * @type {String}
   */
  public get icon() {
    if(import.meta.env.DEV) {
      const __dirname = import.meta.url.replace('file://', '').replace(/\/\w+\.ts$/, '');
      const resolved = resolve(__dirname, '../', 'icons', `${this.name}.png`);
      return `file://${resolved}`;
    }
    return this.#icon;
  }

  public get mirrorInfo():mirrorInfo {
    const allOptions = this.options;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _v, ...options } = allOptions;
    return {
      version: this.version,
      isDead: this.isDead,
      name: this.name,
      displayName: this.displayName,
      host: this.host,
      enabled: this.enabled,
      icon: this.icon,
      langs: this.langs,
      meta: this.meta,
      options: options,
      entryLanguageHasItsOwnURL: this.entryLanguageHasItsOwnURL,
    };
  }

  protected logger(...args: unknown[]) {
    if(env.MODE === 'development') console.log('[api]', `(\x1b[32m${this.name}\x1b[0m)` ,...args);
  }

  /** check if the fetched manga is part of the library */
  #isInLibrary(mirror:string, langs: mirrorsLangsType[], url:string) {
    return MangasDB.getInstance().has(mirror, langs, url);
  }

  /**
   * Manga Page builder
   */
  protected async mangaPageBuilder(mg:Partial<Omit<MangaPage , 'userCategories'|'inLibrary'|'mirror'|'id'> &
  {
    /** force a specific id */
    id?: string
  }>):Promise<MangaPage> {

    // check data integrity
    if(!mg) throw new Error('mirror_might_be_outdated');
    if(!mg.langs || !mg.langs.length) throw new Error('mirror_might_be_outdated');
    if(!mg.chapters || !mg.chapters.length) throw new Error('mirror_might_be_outdated');
    if(!mg.url || !mg.url.length) throw new Error('mirror_might_be_outdated');
    if(!mg.name || !mg.name.length) throw new Error('mirror_might_be_outdated');
    // these can be empty arrays
    if(!mg.covers) throw new Error('mirror_might_be_outdated');
    if(!mg.tags) throw new Error('mirror_might_be_outdated');
    if(!mg.authors) throw new Error('mirror_might_be_outdated');

    const { url, langs, name, displayName, covers, synopsis, tags, authors, chapters } = mg;

    let id: string;
    if(mg.id) id = await this.#uuidv5(true, { langs, url, id: mg.id });
    else id = await this.#uuidv5(false, { langs, url });

    return {
      id,
      url,
      langs,
      name,
      displayName,
      covers,
      synopsis,
      tags,
      authors,
      chapters: chapters.sort((a, b) => a.number - b.number),
      mirror: { name: this.name, version: this.version },
      inLibrary: await this.#isInLibrary(this.name, mg.langs, mg.url),
      userCategories: [],
    };
  }

  /**
   * Manga Page chapter builder
   */
  protected async chaptersBuilder(chapter:Partial<Omit<MangaPage['chapters'][0], 'id'|'date'|'read'> &
  {
    /** force a specific id */
    id?: string,
    /** force a date */
    date?: number,
    /** force read status */
    read?: boolean
  }>):Promise<MangaPage['chapters'][0]> {

    // check data integrity
    if(!chapter) throw new Error('mirror_might_be_outdated');
    if(!chapter.lang || !chapter.lang.length) throw new Error('mirror_might_be_outdated');
    if(!chapter.url || !chapter.url.length) throw new Error('mirror_might_be_outdated');
    if(typeof chapter.number !== 'number') throw new Error('mirror_might_be_outdated');

    const { url, lang, date, number, name, volume, group, read } = chapter;

    let id: string;
    if(chapter.id) id = await this.#uuidv5(true, { langs: [lang], url, id: chapter.id });
    else id = await this.#uuidv5(false, { langs: [lang], url });
    return {
      id,
      url,
      lang,
      date: date || Date.now(),
      number,
      name,
      volume,
      group,
      read: typeof read === 'undefined' ? false : read,
    };
  }

  /**
   * Search results and Recommendation builder
   */
  protected async searchResultsBuilder(mg:Partial<Omit<SearchResult, 'mirrorinfo'|'inLibrary'|'id'> &
  {
    /** force a specific id */
    id?: string
  }>):Promise<SearchResult> {

    // check data integrity
    if(!mg.url || !mg.url.length) throw new Error('mirror_might_be_outdated');
    if(!mg.langs || !mg.langs.length) throw new Error('mirror_might_be_outdated');
    if(!mg.name || !mg.name.length) throw new Error('mirror_might_be_outdated');
    // this can be an empty array
    if(!mg.covers) throw new Error('mirror_might_be_outdated');

    const { url, langs, name, covers, synopsis, last_release } = mg;

    let id: string;
    if(mg.id) id = await this.#uuidv5(true, { langs, url, id: mg.id });
    else id = await this.#uuidv5(false, { langs, url });

    return {
      id,
      url,
      langs,
      name,
      covers,
      synopsis,
      last_release,
      mirrorinfo: this.mirrorInfo,
      inLibrary: await this.#isInLibrary(this.name, mg.langs, mg.url),
    };
  }

  async #uuidv5(
    force:boolean,
    options: {
      langs: mirrorsLangsType[],
      /**
       * chapter url
       *
       * @important if chapters share the same url the same uuid will be generated
       * @workaround append the chapter number/index/some other identifier at the end of the url
       */
      url: string
      id?: string
    },
  ): Promise<string> {
    if(force && options.id) {
      const mg = await MangasDB.getInstance().get({id: options.id, langs: options.langs});
      if(mg) return mg.id;
      return UUID.getInstance().generate({ mirror: { name: this.name, version: this.version }, ...options } as uuid, true);
    }
    if(!force && options.url && options.langs) {
      const mg = await MangasDB.getInstance().get({ mirror: this.name, langs: options.langs, url: options.url });
      if(mg) return mg.id;
      return UUID.getInstance().generate({ mirror: { name: this.name, version: this.version }, ...options } as uuid);
    }
    throw Error('UUID.getInstance(): missing options');
  }

  /** change the mirror settings */
  changeSettings(opts: Record<string, unknown>) {
    this.options = { ...this.options, ...opts };
    // update this.host if mirror is self-hosted
    if(opts.host || opts.protocol || opts.port) {
      if(this.options.host && typeof this.options.host === 'string') this.host = this.options.host;
      if(this.options.protocol && typeof this.options.protocol === 'string') this.host = this.options.protocol + '://' + this.host;
      if(this.options.port && typeof this.options.port === 'number') this.host = this.host + ':' + this.options.port;
    }
    if(opts.login || opts.password) {
      this.login();
    }
  }

  /**
   *
   * @param url the url to fetch
   * @param referer the referer to use
   * @param dependsOnParams whether the data depends on the query parameters
   * @example
   * // dependsOnParams: true
   * const url = 'https://www.example.com/images?id=1';
   * downloadImage(url, true)
   * // dependsOnParams: false
   * const url = 'https://www.example.com/images/some-image.jpg?token=123';
   * downloadImage(url, false)
   */
  protected async downloadImage(url:string, referer?:string, dependsOnParams = false, config?:AxiosRequestConfig):Promise<string|undefined> {
    const {identifier, filename} = await this.#generateCacheFilename(url, dependsOnParams);

    const cache = await this.#loadFromCache({identifier, filename});
    if(cache) return this.#returnFetch(cache, filename);

    // fetch the image using axios, or use puppeteer as fallback
    let buffer:Buffer|undefined;
    try {
      const ab = await this.#axios.get<ArrayBuffer>(url,  { responseType: 'arraybuffer', headers: { referer: referer || this.host }, ...config, timeout: 5000 });
      buffer = Buffer.from(ab.data);
    } catch {
      const res = await this.crawler({url, referer: referer||this.host, waitForSelector: `img[src^="${identifier}"]`, ...config, timeout: 10000 }, true);
      if(res instanceof Buffer) buffer = res;
    }

    // if none of the methods worked, return undefined
    if(!buffer) return this.#returnFetch(undefined);

    const { mime } = await this.getFileMime(buffer);
    if(mime && mime.startsWith('image/')) {
      if(this.options.cache) this.#saveToCache(filename, buffer);
      return this.#returnFetch(buffer, filename);
    }
  }

  private async getFileMime(buffer:Buffer) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    const { fileTypeFromBuffer } = await (eval('import("file-type")') as Promise<typeof import('file-type')>);
    const fT = await fileTypeFromBuffer(buffer);
    if(fT) return { mime: fT.mime };
    else return { mime: 'image/jpeg' };
  }

  private async filenamify(string:string) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    const imp = await (eval('import("filenamify")') as Promise<typeof import('filenamify')>);
    const filenamify = imp.default;
    return filenamify(string);
  }

  protected async post<PLOAD, RESP = unknown>(url:string, data:PLOAD, type: 'post'|'patch'|'put'|'delete' = 'post', config?:AxiosRequestConfig) {
    try {
      const resp = await this.#axios[type]<RESP>(url, data, { ...config, timeout: 5000 });
      return this.#returnFetch(resp.data);
    } catch(e) {
      if((e as AxiosError).response) {
        this.logger({
          type: 'post error',
          message: JSON.stringify((e as AxiosError).response?.data,null,2),
          url,
        });
      } else if(e instanceof Error){
        this.logger({
          type: 'post error',
          message: JSON.stringify(e.message,null,2),
          url,
        });
      } else {
        this.logger({
          type: 'post error',
          message: e,
          url,
        });
      }
      return this.#returnFetch(undefined);
    }
  }

  protected async fetch(config: ClusterJob, type:'html'):Promise<CheerioAPI>
  protected async fetch<T>(config: ClusterJob, type:'json'):Promise<T>
  protected async fetch(config: ClusterJob, type:'string'):Promise<string>
  protected async fetch<T>(config: ClusterJob, type: 'html'|'json'|'string'): Promise<T|CheerioAPI|string> {
    // fetch the data (try to use axios first, then puppeteer)
    const res = await this.#internalFetch<T>(config, type);

    // throw an error if both axios and puppeteer failed
    if(typeof res === 'undefined' || res instanceof Error) {
      throw res || new Error('no_response');
    }
    // parse the data into the requested type
    else if(typeof res === 'string') {
      if(type === 'string') return this.#returnFetch(res);
      if(type === 'html') return this.#returnFetch(this.#loadHTML(res));
      if(type === 'json') {
        try {
          return this.#returnFetch<T>(JSON.parse(res));
        } catch {
          throw new Error('invalid_json');
        }
      }
      throw new Error(`unknown_type: ${type}`);
    }
    // if the data is a JSON object, parse it into the requested type
    else if(typeof res === 'object') {
      if(type === 'json') return this.#returnFetch(res);
      if(type === 'string') return this.#returnFetch(JSON.stringify(res));
      if(type === 'html') {
        throw new Error('cant_parse_json_to_html');
      }
      throw new Error(`unknown_type: ${type}`);
    }
    else {
      throw new Error('unknown_fetch_error');
    }
  }

  async #internalFetch<T>(config: ClusterJob, type: 'html'|'json'|'string') {
    // prepare the config for both Axios and Puppeteer
    config.headers = {
      ...config.headers,
    };

    if(type !== 'json') config.headers.referer = config.referer || this.host.replace(/http(s?):\/\//g, '');
    if(config.cookies) config.headers['Cookie'] = config.cookies.map(c => c.name+'='+c.value+';').join(' ') + ' path=/; domain='+this.host.replace(/http(s?):\/\//g, '');

    try {
      // try to use axios first
      const response = await this.#axios.get<string|T>(config.url, { ...config, timeout: 5000 });

      if(typeof response.data === 'string') {
        if(config.waitForSelector) {
          const $ = this.#loadHTML(response.data);
          if($(config.waitForSelector).length) return response.data;
          else throw new Error(`selector_not_found: ${config.waitForSelector}`);
        }
        return response.data;
      } else {
        if(config.waitForSelector) throw new Error(`unexpected_response: ${typeof response.data}`);
        return response.data;
      }
    } catch(e) {
      // some exceptions where using puppeteer is unnecessary
      if(e instanceof Error) {
        if(e.message.startsWith('unexpected_response')) throw e;
      }
      if(e instanceof AxiosError) {
        const msg = e.response?.data.message?.toLocaleLowerCase() as string | undefined;
        if(msg === 'unauthorized'|| e.response?.status === 401 ) return new Error('unauthorized');
      }
      // if axios fails or the selector is not found, try puppeteer
      return this.crawler({...config, waitForSelector: config.waitForSelector, timeout: 10000 }, false, type);
    }
  }

  #returnFetch<T>(data : T, filename?: undefined):T
  #returnFetch<T>(data : T, filename: string):string
  #returnFetch<T>(data : T, filename?: string|undefined):T|string {
    if(data instanceof Buffer && filename) {
      return FileServer.getInstance('fileserver').serv(data, filename);
    }
    return data;
  }

  /**
   * Cheerio.load() wrapper
   * @param {string | Buffer | AnyNode | AnyNode[]} content
   * @param {CheerioOptions | null | undefined} options
   * @param {boolean | undefined} isDocument
   * @returns {CheerioAPI}
   */
  #loadHTML(content: string | Buffer | AnyNode | AnyNode[], options?: CheerioOptions | null | undefined, isDocument?: boolean | undefined): CheerioAPI {
    return load(content, options, isDocument);
  }

  protected getVariableFromScript<Expected>(varname:string, sc:string):Expected {
    let res = undefined;
    // eslint-disable-next-line no-useless-escape
    const rx = new RegExp('(var|let|const)\\s+' + varname + '\\s*=\\s*([0-9]+|\\"|\\\'|\\\{|\\\[|JSON\\s*\\\.\\s*parse\\\()', 'gmi');
    const match = rx.exec(sc);
    if (match) {
        const ind = match.index;
        const varchar = match[2];
        const start = sc.indexOf(varchar, ind) + 1;
        if (varchar.match(/[0-9]+/)) {
            res = Number(varchar);
        } else {
            if (varchar === '"' || varchar === '\'') { // var is a string
                let found = false,
                    curpos = start,
                    prevbs = false;
                while (!found) {
                    const c = sc.charAt(curpos++);
                    if (c === varchar && !prevbs) {
                        found = true;
                        break;
                    }
                    prevbs = c === '\\';
                }
                res = sc.substring(start, curpos - 1);
            } else { // if (varchar === '[' || varchar === "{" || varchar === 'JSON.parse(') { // var is object or array or parsable
                let curpos = start + varchar.length - 1,
                    openings = 1;
                const opening = varchar === 'JSON.parse(' ? '(' : varchar,
                      opposite = varchar === '[' ? ']' : (varchar === '{' ? '}' : ')');
                while (openings > 0 && curpos < sc.length) {
                    const c = sc.charAt(curpos++);
                    if (c === opening) openings++;
                    if (c === opposite) openings--;
                }
                let toparse = sc.substring(start - 1 + varchar.length - 1, curpos);
                if (toparse.match(/atob\s*\(/g)) { // if data to parse is encoded using btoa
                    const m = /(?:'|").*(?:'|")/g.exec(toparse);
                    if (m) toparse = Buffer.from(m[0].substring(1, m[0].length - 1)).toString('base64');
                }
                res = JSON.parse(toparse);
            }
        }
    }
    return res;
  }

  async #saveToCache(filename:string, buffer:Buffer) {
    if(typeof env.USER_DATA === 'undefined') throw Error('USER_DATA is not defined');
    if(this.cacheEnabled) {
      writeFileSync(resolve(env.USER_DATA, '.cache', this.name, filename), buffer);
      this.logger('saved to cache', filename);
    }
  }

  async #loadFromCache(id:{ identifier: string, filename:string }):Promise<Buffer|string|undefined> {
    if(typeof env.USER_DATA === 'undefined') throw Error('USER_DATA is not defined');
    if(this.cacheEnabled) {
      let cacheResult:{mime: string|undefined, buffer:Buffer} | undefined;
      try {
        const buffer = readFileSync(resolve(env.USER_DATA, '.cache', this.name, id.filename));
        cacheResult = { mime:undefined, buffer };
      } catch {
        cacheResult = undefined;
      }
      if(cacheResult) {
        this.logger('cache hit', id.filename);
        return cacheResult.buffer;
      }
    }
  }

  async #generateCacheFilename(url:string, dependsOnParams:boolean) {
    const uri = new URL(url);
    const identifier = uri.origin + uri.pathname + (dependsOnParams ? uri.search : '');
    const filename = await this.filenamify(identifier);
    return {filename, identifier};
  }

  /** stop listening to "stop" messages */
  protected stopListening(socket:socketInstance|Scheduler) {
    if(!(socket instanceof Scheduler)) {
      socket.removeAllListeners('stopShowManga');
      socket.removeAllListeners('stopShowChapter');
      socket.removeAllListeners('stopSearchInMirrors');
      socket.removeAllListeners('stopShowRecommend');
      socket.removeAllListeners('stopShowImports');
    }
  }
}

