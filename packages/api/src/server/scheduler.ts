import type { ClientToServerEvents } from '@api/client/types';
import MangasDB from '@api/db/mangas';
import SettingsDB from '@api/db/settings';
import mirrors from '@api/models';
import type Mirror from '@api/models/abstracts';
import type MirrorInterface from '@api/models/interfaces';
import type { MangaErrorMessage, SearchErrorMessage } from '@api/models/types/errors';
import type { MangaInDB, MangaPage } from '@api/models/types/manga';
import type { SearchResult } from '@api/models/types/search';
import type { TaskDone } from '@api/models/types/shared';
import { arraysEqual } from '@api/server/helpers/arrayEquals';
import type { ServerToClientEvents } from '@api/server/types/index';
import type { LogChapterError, LogChapterNew, LogChapterRead, LogMangaNewMetadata } from '@api/server/types/scheduler';
import EventEmitter from 'events';
import { existsSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { env } from 'process';
import type { Server as ioServer } from 'socket.io';
import type TypedEmitter from 'typed-emitter';

export default class Scheduler extends (EventEmitter as new () => TypedEmitter<ServerToClientEvents>) {
  static #instance: Scheduler;
  #intervals: {
    updates: NodeJS.Timer;
    nextupdate: number;
    cache: NodeJS.Timer;
    nextcache: number;
  };
  #ongoing = {
    updates: false,
    cache: false,
  };

  mangaLogs:(LogChapterError|LogChapterNew|LogChapterRead|LogMangaNewMetadata)[] = [];
  cacheLogs: { date: number, message: 'cache'|'cache_error', files:number, size:number }[] = [];
  io?: ioServer<ClientToServerEvents, ServerToClientEvents>;
  constructor() {
    super();

    this.setMaxListeners(0);

    // we are just asking this.#update() to check every 60s if updates are needed
    // then according to "this.settings.waitBetweenUpdates" the acutal update will be processed (or not)

    this.#intervals = {
      nextcache: Date.now() + 60000,
      cache: setTimeout(this.#clearcache.bind(this), 60000),
      nextupdate: Date.now() + 60000,
      updates: setTimeout(this.update.bind(this), 60000),
    };
  }

  static getInstance(): Scheduler {
    if (!this.#instance) {
      this.#instance = new this();
    }
    return this.#instance;
  }

  get logs() {
    return { manga: this.mangaLogs, cache: this.cacheLogs };
  }

  get settings() {
    return SettingsDB.getInstance().data;
  }

  get cache() {
    return SettingsDB.getInstance().data.cache;
  }

  get cacheEnabled() {
    return SettingsDB.getInstance().data.cache.age.enabled || SettingsDB.getInstance().data.cache.size.enabled;
  }

  get isUpdatingMangas() {
    return this.#ongoing.updates;
  }

  async registerIO(io:ioServer) {
    this.logger('Scheduler loaded');
    this.io = io;
    try {
      this.#clearcache();
      await this.update(false, true);
    } catch(e) {
      this.logger('catch!', e);
      return;
    }
    return;
  }

  #addMangaLog(log: LogChapterError|LogChapterNew|LogChapterRead|LogMangaNewMetadata):void {
    if(!this.settings.library.logs.enabled) return;
    this.mangaLogs.push(log);
    if(this.mangaLogs.length > this.settings.library.logs.max) {
      this.mangaLogs.shift();
    }
  }

  addCacheLog(message:'cache', files:number, size:number) {
    if(!this.settings.library.logs.enabled) return;
    this.cacheLogs.push({date: Date.now(), message, files, size});
    if(this.cacheLogs.length > this.settings.library.logs.max) {
      this.cacheLogs.shift();
    }
  }

  protected logger(...args: unknown[]) {
    if(env.MODE === 'development') console.log('[api]', `(\x1b[35m${this.constructor.name}\x1b[0m)` ,...args);
  }

  #clearcache() {
    if(this.cacheEnabled) {
      const { age, size } = this.cache;
      let cacheFiles = Scheduler.getAllCacheFiles();
      const total = { files: 0, size:0 };
      if(age.enabled) {
        // delete files older than max, and remove them from the array
        cacheFiles = cacheFiles.filter(file => {
          if(file.age > age.max) {
            total.files++;
            total.size += file.size;
            Scheduler.unlinkSyncNoFail(file.filename);
            return true;
          }
          return false;
        });
      }
      if(size.enabled) {
        const totalsize = cacheFiles.reduce((acc, file) => acc + file.size, 0);
        if (totalsize > size.max) {
          // delete files until the size is under the max starting from the oldest
          cacheFiles.sort((a, b) => a.age - b.age);
          cacheFiles.forEach(file => {
            total.files++;
            total.size += file.size;
            Scheduler.unlinkSyncNoFail(file.filename);
            if(total.size < size.max) return false;
          });
        }
      }
      if(total.files > 0 && total.size > 0) {
        this.addCacheLog('cache', total.files, total.size);
        this.logger('done purging cache');
      }
      this.restartCache();
    }
  }

  static getAllCacheFiles(dirPath?:string, arrayOfFiles?:{ filename: string, size:number, age:number }[]): { filename: string, size:number, age:number }[] {
    if(typeof env.USER_DATA === 'undefined') throw Error('USER_DATA is not defined');
    const path = dirPath || resolve(env.USER_DATA, '.cache');
    const files = readdirSync(path);
    let res = arrayOfFiles || [];
    files.forEach(function(file) {
      if(existsSync(join(path, file))) {
        const stat = statSync(path + '/' + file);
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          res = Scheduler.getAllCacheFiles(path + '/' + file, res);
        } else if(!stat.isSymbolicLink()) {
          const filePath = join(path, file);
          res.push({filename: filePath, size: stat.size, age: Date.now() - stat.mtime.getTime()});
        }
      }
    });
    return res;
  }

  static unlinkSyncNoFail(file:string) {
    try {
      unlinkSync(file);
    } catch(e) {
      // do nothing
    }
  }

  restart() {
    clearTimeout(this.#intervals.cache);
    clearTimeout(this.#intervals.updates);
    if(this.cacheEnabled) {
      this.#intervals.cache = setTimeout(this.update.bind(this), 60000);
      this.#intervals.nextcache = Date.now() + 60000;
    }
    this.#intervals.nextupdate = Date.now() + 60000;
    this.#intervals.updates = setTimeout(this.#clearcache.bind(this), 60000);
  }

  restartUpdate() {
    clearTimeout(this.#intervals.updates);
    this.#intervals.updates = setTimeout(this.update.bind(this), 60000);
    this.#intervals.nextupdate = Date.now() + 60000;
  }

  restartCache() {
    clearTimeout(this.#intervals.cache);
    if(this.cacheEnabled) {
      this.#intervals.cache = setTimeout(this.#clearcache.bind(this), 60000);
      this.#intervals.nextcache = Date.now() + 60000;
    }
  }

  /**
   * List all mangas that needs to be updated and start updates
   * @param force if true, will force the update of all the mangas
   * @param onlyfixes do run update, just fix mangas
   */
  async update(force?:boolean, onlyfixes?:boolean) {
    // if we are already updating, return
    if(this.#ongoing.updates) return;
    // emit to all the clients that we are updating
    this.#ongoing.updates = true;
    if(this.io) this.io.emit('startMangasUpdate');
    // get the list of mangas
    const {updates, fixes} = await this.#getMangasToUpdate(force);

    const nbMangas = Object.keys(updates).reduce((acc, key) => acc + updates[key].length, 0);
    if(nbMangas > 0) this.logger('updating...');
    // fixes mangas
    for(const mirrorName of Object.keys(fixes)) {
      const mirror = mirrors.find(m => m.name === mirrorName);
      if(mirror) await this.#fixMangas(mirror, fixes[mirrorName]);
    }

    if(!onlyfixes) {
      // update mangas
      for(const mirrorName of Object.keys(updates)) {
        const mirror = mirrors.find(m => m.name === mirrorName);
        if(mirror) await this.#updateMangas(mirror, updates[mirrorName]);
      }
    }
    // emit to all the clients that we are done updating
    this.#ongoing.updates = false;
    if(this.io) this.io.emit('finishedMangasUpdate');
    if(nbMangas > 0) this.logger('update finished');
    // restart update intervals/timeouts
    this.restartUpdate();
  }

  /**
   * Get a list of manga that need to be updated, grouped by mirrors
   * @param force if true, will force the update of all the mangas
   */
  async #getMangasToUpdate(force?:boolean) {
    const indexes = await MangasDB.getInstance().getIndexes();

    const indexesToUpdate = indexes.filter(i => {
        // do not update manga's for disabled mirrors or entry version doesn't match mirror version
        const find = mirrors.find(m => m.name === i.mirror.name);
        if(find && !find.enabled) return false;
        if(find && find.version !== i.mirror.version) return false;
        // do not update manga's explicitly marked as "do not update";
        if(!i.update) return false;
        // update if force is true or enough time has passed
        if(force) return true;
        else if((i.lastUpdate + this.settings.library.waitBetweenUpdates) < Date.now()) return true;
        else return false;
    });

    const mangasToUpdate:MangaInDB[] = [];

    for(const index of indexesToUpdate) {
      const manga = await MangasDB.getInstance().getByFilename(index.file);
      mangasToUpdate.push(manga);
    }
    // mangas to update by mirror
    const mangasToUpdateByMirror: sortedMangas<typeof mangasToUpdate[0]> = {};
    mangasToUpdate.forEach(manga => {
      if(!mangasToUpdateByMirror[manga.mirror.name]) mangasToUpdateByMirror[manga.mirror.name] = [];
      mangasToUpdateByMirror[manga.mirror.name].push(manga);
    });

    /**
     * - mangas where version doesn't match mirror's version
     * - mangas from dead mirrors
     */
    const indexesToFix = indexes.filter(manga => {
      const find = mirrors.find(m => m.name === manga.mirror.name);
      if(find && (find.version !== manga.mirror.version || find.isDead)) return true;
      else return false;
    });


    const mangasToFix:MangaInDB[] = [];

    for(const fix of indexesToFix) {
      const manga = await MangasDB.getInstance().getByFilename(fix.file);
      mangasToFix.push(manga);
    }
    // mangas to fix by mirror
    const mangasToFixByMirror: sortedMangas<typeof mangasToUpdate[0]> = {};
    mangasToFix.forEach(manga => {
      if(!mangasToFixByMirror[manga.mirror.name]) mangasToFixByMirror[manga.mirror.name] = [];
      mangasToFixByMirror[manga.mirror.name].push(manga);
    });


    return { updates: mangasToUpdateByMirror, fixes: mangasToFixByMirror };
  }

  /**
   * Fetch the data, check if there's any difference and update accordingly
   */
  async #updateMangas(mirror:Mirror & MirrorInterface, mangas: MangaInDB[]) {
    const db = MangasDB.getInstance();
    for(const manga of mangas) {
      this.logger('updating', manga.name, '@', manga.mirror);
      try {
        const fetched = await this.#fetch(mirror, manga);
        const id = manga.id;

        // check if some keys changed
        if(manga.name !== fetched.name) {
          this.#addMangaLog({date: Date.now(), id, message: 'log_manga_metadata', data: { tag: 'name', oldVal: manga.name, newVal: fetched.name }});
          manga.name = fetched.name;
        }

        // For mirror which only have 1 lang, which might change
        if(mirror.langs.length === 1 || mirror.mirrorInfo.entryLanguageHasItsOwnURL) {
          if(manga.langs[0] !== fetched.langs[0]) {
            this.#addMangaLog({date: Date.now(), id, message: 'log_manga_metadata', data: { tag: 'langs', oldVal: manga.langs, newVal: fetched.langs }});
            manga.langs = fetched.langs;
            fetched.chapters.map(x => {
              return { ...x, lang: fetched.langs[0] };
            });
          }
        }

        if(manga.synopsis !== fetched.synopsis) {
          this.#addMangaLog({date: Date.now(), id, message: 'log_manga_metadata', data: { tag: 'synopsis', oldVal: manga.synopsis, newVal: fetched.synopsis }});
          manga.synopsis = fetched.synopsis;
        }
        if(!arraysEqual(manga.authors, fetched.authors)) {
          this.#addMangaLog({date: Date.now(), id, message: 'log_manga_metadata', data: { tag: 'authors', oldVal: manga.authors, newVal: fetched.authors }});
          manga.authors = fetched.authors;
        }

        const mangaCoverClone = [...manga.covers].map(c => c.replace(/^(.*cover_)?/g, '')).sort();
        const fetchedCoverClone = [...fetched.covers].map(c => c.replace(/^(.*files\/)?/g, '')).sort();
        if(!arraysEqual(mangaCoverClone, fetchedCoverClone)) {
          manga.covers = fetched.covers;
          this.#addMangaLog({date: Date.now(), id, message: 'log_manga_metadata', data: { tag: 'covers' }});
        }

        const mangaTagClone = [...manga.tags].sort();
        const fetchedTagClone = [...fetched.tags].sort();
        if(!arraysEqual(mangaTagClone, fetchedTagClone)) {
          manga.tags = fetched.tags;
          this.#addMangaLog({date: Date.now(), id, message: 'log_manga_metadata', data: { tag: 'tags' }});
        }

        for(const chapter of fetched.chapters) {
          const chapterInDB = manga.chapters.find(c => c.id === chapter.id);
          if(chapterInDB) {
            if(!chapterInDB.read && chapter.read) {
              chapterInDB.read = true;
              this.#addMangaLog({ date: Date.now(), id, message: 'log_chapter_read', data: chapterInDB });
            }
          } else {
            manga.chapters.push(chapter);
            this.#addMangaLog({ date: Date.now(), id, message: 'log_chapter_new', data: chapter });
          }
        }
        await db.add({manga: {...manga, meta: {...manga.meta, lastUpdate: Date.now() } } });
      } catch(e) {
        let err = '';
        if(e instanceof Error) err = e.message;
        if(typeof e === 'string') err = e;
        this.#addMangaLog({ date: Date.now(), id: manga.id, message: 'log_chapter_error', data: err});
      }
    }
  }

  /**
   * Re-add mangas with newer version of their mirrors
   * - If mirror is marked as dead, mangas are automatically marked as "broken"
   * - if new version of mirror couldn't find a manga with a matching name, manga is marked as "broken"
   *
   * @important Broken mangas require user to migrate to manually migrate to another mirror
   * @important migrated mangas may have new ids
   */
  async #fixMangas(mirror:Mirror & MirrorInterface, mangas: MangaInDB[]) {
    // if mirror is dead
    if(mirror.isDead) {
      for(const manga of mangas) {
        await MangasDB.getInstance().add({ manga: { ...manga, meta: { ...manga.meta, broken: true } }, settings: { ...manga.meta.options } });
        this.logger('marked entry', manga.name, 'as broken: mirror dead');
      }
      return;
    }
    // if mirror version != mangas version
    for(const manga of mangas) {
      // search the manga with a newer version of mirror
      try {
        const remoteManga = await this.#search(mirror, manga);
        // if there no exact match mark manga as "broken"
        if(!remoteManga) {
          await MangasDB.getInstance().add({ manga: { ...manga, meta: { ...manga.meta, broken: true } }, settings: { ...manga.meta.options } });
          this.logger('marked entry', manga.name, 'as broken: could not migrate');
        }
        // else copy as much data as possible
        else {
          // copy chapters read status
          remoteManga.chapters.map(c => {
            const find = manga.chapters.find(f => f.number === c.number);
            return { ...c, read: find ? find.read : false };
          });
          // copy meta and reader option
          const meta = manga.meta;
          const userCategories = manga.userCategories;
          // remove old version
          for(const lang of manga.langs) {
            await MangasDB.getInstance().remove(manga, lang);
          }
          // add new version
          await MangasDB.getInstance().add({ manga: { ...remoteManga, meta: {...meta, broken: false }, userCategories } });
          this.logger('migrated:', manga.name, 'version:', remoteManga.mirror.version);
        }
      } catch(e) {
        await MangasDB.getInstance().add({ manga: { ...manga, meta: { ...manga.meta, broken: true } }, settings: { ...manga.meta.options } });
        this.logger('marked entry', manga.name, 'as broken: could not migrate');
        this.logger(e);
      }
    }
  }

  /**
   * Search manga (exact match)
   */
  async #search(mirror:Mirror & MirrorInterface, query: MangaInDB) {
    const search:() => Promise<SearchResult[]> = () => new Promise(resolve => {
      const reqId = Date.now();
      const results:SearchResult[] = [];

      // auto-resolve after 60s
      let done = false;
      setTimeout(() => {
        if(!done) {
          done = true;
          this.removeListener('searchInMirrors', listener);
          resolve(results);
        }
      }, 60*1000);

      const listener = (id: number, res: SearchResult | SearchResult[] | SearchErrorMessage | TaskDone) => {
        if(id !== reqId) return;
        // we ignore SearchErrorMessage
        // at best we will find result next time update() is called
        // at worst this process will repeat until we update the app and mark the mirror as dead

        if(Array.isArray(res)) res.forEach(r => results.push(r));
        else if((res as SearchResult).name) results.push(res as SearchResult);
        else if((res as TaskDone).done) {
          if(done) return;
          done = true;
          this.removeListener('searchInMirrors', listener);
          return resolve(results);
        }
      };

      this.on('searchInMirrors', listener.bind(this));
      mirror.search(query.name, query.langs, this, reqId);
    });
    const searchResults = await search();
    const match = searchResults.find(s => s.name === query.name);
    if(!match) return;
    else return this.#fetch(mirror, match);
  }

  /**
   * Fetch data directly from the mirror
   */
  async #fetch(mirror:Mirror & MirrorInterface, manga: MangaInDB|SearchResult):Promise<MangaPage> {
    return new Promise((resolve, reject) => {
      const reqId = Date.now();
      // setting up our listener
      const listener = (id:number, mangaFromMirror:MangaInDB | MangaPage | MangaErrorMessage ) => {
        if(id !== reqId) return;
        if(isMangaPage(mangaFromMirror)) {
          this.removeListener('showManga', listener);
          resolve(mangaFromMirror);
        } else {
          this.removeListener('showManga', listener);
          reject(manga);
        }
      };
      this.on('showManga', listener.bind(this));
      mirror.manga(manga.url, manga.langs, this, reqId);
    });
  }
}

type sortedMangas<T> = {
  [key: string]: T[];
}

function isMangaPage(manga: MangaInDB|MangaPage|MangaErrorMessage): manga is MangaPage {
  return typeof (manga as MangaInDB).meta === 'undefined';
}

