import Mirror from '@api/models/abstracts';
import icon from '@api/models/icons/mangafox.png';
import type MirrorInterface from '@api/models/interfaces/index';
import type { MangaPage } from '@api/models/types/manga';
import Scheduler from '@api/server/scheduler';
import type { socketInstance } from '@api/server/types';
import type { mirrorsLangsType } from '@i18n/index';

class Mangafox extends Mirror<{adult: boolean}> implements MirrorInterface {

  constructor() {
    super({
      version: 1,
      isDead: false,
      host: 'https://fanfox.net',
      althost: [
        'http://fanfox.net',
        'https://www.fanfox.net',
        'http://www.fanfox.net',
        'https://mangafox.me',
        'http://mangafox.me',
        'https://www.mangafox.me',
        'http://www.mangafox.me',
      ],
      name: 'mangafox',
      displayName: 'Mangafox',
      langs: ['en'],
      icon,
      meta: {
        speed: 0.7,
        quality: 0.3,
        popularity: 0.6,
      },
      options: { enabled: true, cache:true, adult: true },
      requestLimits: {
        time: 400,
        concurrent: 1,
      },
    });
  }

  isMangaPage(str:string) {
    const res = /^\/manga\/\w+(\/)?$/gmi.test(str);
    if(!res) this.logger('not a manga page', str);
    return res;
  }
  isChapterPage(str:string) {
    const res = /\/manga\/\w+(\/v.+)?\/c([0-9]+(\.))?[0-9]+?\/\d+\.html$/gmi.test(str);
    if(!res) this.logger('not a chapter page', str);
    return res;
  }

  getChapterInfoFromString(str:string) {
    const res = /^(Vol\.(.+)\s)?Ch\.([0-9]+(\.)?([0-9]+)?)(\s-\s(.*))?$/gmi.exec(str);
    if(!res) this.logger('not a chapter string', str);
    return res;
  }

  async search(query:string, langs:mirrorsLangsType[], socket: socketInstance|Scheduler, id:number) {
    // we will check if user don't need results anymore at different intervals
    let cancel = false;
    if(!(socket instanceof Scheduler)) {
      socket.once('stopSearchInMirrors', () => {
        this.logger('search canceled');
        this.stopListening(socket);
        cancel = true;
      });
    }
    const url = `${this.host}/search?page=1&title=${query}`;
    if(cancel) return; //=> 1st cancel check before request
    try {
      const $ = await this.fetch({
        url,
        cookies: [{name: 'isAdult', value: this.options.adult ? '1' : '0', path: '/', domain: 'fanfox.net'}],
        waitForSelector: '.bg-gary > .container',
      }, 'html');


      // we loop through the search results
      for(const el of $('ul.manga-list-4-list > li')) {
        if(cancel) break; //=> 2nd cancel check, break out of loop
        const name = $('p.manga-list-4-item-title', el).text().trim();
        const link = $('p.manga-list-4-item-title > a', el).attr('href')?.replace(this.host, '');
        const isMangaLink = this.isMangaPage(link||'');
        // safeguard
        if(!link || !isMangaLink || !name) continue;

        // mangafox images needs to be downloaded.
        const covers:string[] = [];
        const coverLink =  $('img.manga-list-4-cover', el).attr('src');
        if(coverLink) {
          const img = await this.downloadImage(coverLink);
          if(img) covers.push(img);
        }


        const last_chapter = $('p.manga-list-4-item-tip', el).filter((i,e) => $(e).text().trim().indexOf('Latest Chapter:') > -1).text().replace('Latest Chapter:', '').trim();
        let synopsis:string|undefined = $('p.manga-list-4-item-tip:last-of-type', el).text().trim();
        if(synopsis && synopsis.length === 0) synopsis = undefined;
        // check if we can get any info regarding the last chapter
        const match = this.getChapterInfoFromString(last_chapter);
        let last_release;
        if(match && typeof match === 'object') {
          const [, , volumeNumber, chapterNumber, , , , chapterName] = match;
          last_release = {
            name: chapterName ? chapterName.trim() : undefined,
            volume: volumeNumber && !isNaN(parseFloat(volumeNumber)) ? parseFloat(volumeNumber) : undefined,
            chapter: chapterNumber ? parseFloat(chapterNumber) : 0,
          };
        } else {
          last_release = {
            name: last_chapter,
            volume: undefined,
            chapter: undefined,
          };
        }

        const searchResults = await this.searchResultsBuilder({
          name,
          url: link,
          covers,
          synopsis,
          last_release,
          langs: this.langs,
        });
        // we return the results based on SearchResult model
        socket.emit('searchInMirrors', id, searchResults);
      }
      if(cancel) return;
    } catch(e) {
        this.logger('error while searching mangas', e);
        if(e instanceof Error) socket.emit('searchInMirrors', id, {mirror: this.name, error: 'search_error', trace: e.message});
        else if(typeof e === 'string') socket.emit('searchInMirrors', id, {mirror: this.name, error: 'search_error', trace: e});
        else socket.emit('searchInMirrors', id, {mirror: this.name, error: 'search_error' });
    }
    socket.emit('searchInMirrors', id, { done: true });
    return this.stopListening(socket);
  }

  async manga(link:string, langs:mirrorsLangsType[], socket:socketInstance|Scheduler, id:number) {
    // we will check if user don't need results anymore at different intervals
    let cancel = false;
    if(!(socket instanceof Scheduler)) {
      socket.once('stopShowManga', () => {
        this.logger('fetching manga canceled');
        this.stopListening(socket);
        cancel = true;
      });
    }
    // safeguard, we return an error if the link is not a manga page
    const isLinkaPage = this.isMangaPage(link);
    if(!isLinkaPage) {
      this.stopListening(socket);
      return socket.emit('showManga', id, {error: 'manga_error_invalid_link'});
    }

    if(cancel) return;

    try {


      const $ = await this.fetch({
        url: `${this.host}${link}`,
        cookies: [{name: 'isAdult', value: this.options.adult ? '1' : '0', path: '/', domain: 'fanfox.net'}],
        waitForSelector: 'ul.detail-main-list > li > a',
      }, 'html');

      // title of manga
      const name = $('span.detail-info-right-title-font').text().trim();
      // synopsis
      const synopsis = $('p.fullcontent').text().trim(); // optional

      // covers (some mirror have multiple covers, not fanfox though)
      const covers:string[] = [];
      const coverLink =  $('img.detail-info-cover-img').attr('src');
      if(coverLink) {
        // mangafox images needs to be downloaded (you can't just link the external url due to cors).
        const img = await this.downloadImage(coverLink);
        if(img) covers.push(img);
      }

      // authors and tags
      const authors:string[] = [];
      const tags:string[] = [];

      $('p.detail-info-right-say > a').each((i, el) => {
        const author = $(el).text().toLocaleLowerCase().trim();
        if(author.length) authors.push(author);
      });

      $('p.detail-info-right-tag-list > a').each((i, el) => {
        const tag = $(el).text().toLocaleLowerCase().trim();
        if(tag.length) tags.push(tag);
      });

      // chapters table
      const chapters:MangaPage['chapters'] = [];
      const tablesize = $('ul.detail-main-list > li > a').length;

      for(const [i, el] of $('ul.detail-main-list > li > a').toArray().reverse().entries()) {
        if(cancel) break;
        // making sure the link match the pattern we're expecting
        const chapterHref = $(el).attr('href')?.replace(this.host, '');
        if(!chapterHref || !this.isChapterPage(chapterHref)) return;

        // a regex that help us get the volume, chapter number and chapter name
        const match = this.getChapterInfoFromString($('.detail-main-list-main > p.title3', el).text());
        if(!match || typeof match !== 'object') return;

        // getting capture groups
        const [, , volumeNumber, chapterNumber, , , , chapterName] = match;

        // parsing the values
        const volumeNumberInt = volumeNumber !== undefined ? parseFloat(volumeNumber) : undefined; // if no volume number is given, we set it to undefined
        const chapterNumberFloat = chapterNumber !== undefined ? parseFloat(chapterNumber) : tablesize-i; // if no chapter number is found we fallback to the position in the table
        const chapterNameTrim = chapterName !== undefined ? chapterName.trim() : undefined; // if no chapter name is given, we set it to undefined
        const chapterUrl = chapterHref.trim();

        // ensure we at least have a chapter number OR a chapter name
        if(chapterNameTrim === undefined && chapterNumberFloat === undefined) return;

        const built = await this.chaptersBuilder({
          name: chapterNameTrim,
          number: chapterNumberFloat,
          volume: volumeNumberInt ? isNaN(volumeNumberInt) ? undefined : volumeNumberInt : undefined,
          url: chapterUrl,
          lang: this.langs[0],
        });

        chapters.push(built);
      }
      // emitting the manga page based on MangaPage model
      if(cancel) return;

      const mg = await this.mangaPageBuilder({
        url: link,
        langs: this.langs,
        name,
        synopsis,
        covers,
        authors,
        tags,
        chapters: chapters.sort((a,b) => a.number - b.number),
      });

      socket.emit('showManga', id, mg);
    } catch(e) {
      this.logger('error while fetching manga', e);
      // we catch any errors because the client needs to be able to handle them
      if(e instanceof Error) socket.emit('showManga', id, {error: 'manga_error', trace: e.message});
      else if(typeof e === 'string') socket.emit('showManga', id, {error: 'manga_error', trace: e});
      else socket.emit('showManga', id, {error: 'manga_error_unknown'});
    }
    return this.stopListening(socket);
  }

  // credit mac @ AMR: https://gitlab.com/all-mangas-reader/all-mangas-reader-2/-/commit/316cf5e01c2182f13ea7a374cb05382030644bdf
  async chapter(link:string, lang:mirrorsLangsType, socket:socketInstance|Scheduler, id:number, callback?: (nbOfPagesToExpect:number)=>void, retryIndex?:number) {
    // we will check if user don't need results anymore at different intervals
    let cancel = false;
    if(!(socket instanceof Scheduler)) {
      socket.once('stopShowChapter', () => {
        this.logger('fetching chapter canceled');
        this.stopListening(socket);
        cancel = true;
      });
    }


    // safeguard, we return an error if the link is not a chapter page
    const isLinkaChapter = this.isChapterPage(link);
    if(!isLinkaChapter) {
      socket.emit('showChapter', id, {error: 'chapter_error_invalid_link'});
      return this.stopListening(socket);
    }

    if(cancel) return;
    try {
      const $ = await this.fetch({
        url: `${this.host}${link}`,
        cookies: [{name: 'isAdult', value: this.options.adult ? '1' : '0', path: '/', domain: 'fanfox.net'}],
        waitForSelector: '.reader-main',
      }, 'html');

      // we gather every parameters needed to build the request to the actual image
      const imagecount = retryIndex || this.getVariableFromScript<number>('imagecount', $.html());
      let chapterurl = `${this.host}${link}`;
      if(!chapterurl.endsWith('/')) chapterurl += '/';
      const chapfunurl = chapterurl.substring(0, chapterurl.lastIndexOf('/') + 1) + 'chapterfun.ashx';
      const cid = this.getVariableFromScript<number>('chapterid', $.html());
      let mkey: unknown = '';
      if ($('#dm5_key', $.html()).length > 0) {
          mkey = $('#dm5_key', $.html()).val();
      }

      // return the number of pages to expect (1-based)
      if(cancel) return;
      if(callback) callback(typeof retryIndex === 'number' ? 1 : imagecount);

      for(const [i] of [...Array(imagecount)].entries()) {
        if(cancel) break;
        // if the user requested a specific page, we will skip the others
        if(typeof retryIndex === 'number' && i !== retryIndex) continue;

        // build parameters for the request
        const params = {
          cid: cid,
          page: i+1,
          key: mkey,
        };

        const data = await this.fetch({url: chapfunurl, params, cookies: [{name: 'isAdult', value: this.options.adult ? '1' : '0', path: '/', domain: 'fanfox.net'}]}, 'string');

        // regexp to parse the arguments to pass to the unpack function, just parse the 4 first arguments
        const regexpargs = /'(([^\\']|\\')*)',([0-9]+),([0-9]+),'(([^\\']|\\')*)'/g;
        const match = regexpargs.exec(data);

        if(match) {
          const args = [match[1], match[3], match[4], match[5].split('|'), 0, {}];
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          let sc = this.#unpack(...args); // call the unpack function
          sc = sc.replace(/\\'/g, '\'');


          // the result is another js function containing the data, we mimic here what it does
          // retrieve the variables
          const key = this.getVariableFromScript<string|undefined>('key', sc) || '',
                pix = this.getVariableFromScript<string>('pix', sc),
                pvalues = this.getVariableFromScript<string[]>('pvalue', sc), // array of scan urls (contains current one and next one)
                pvalue = pvalues.map(img => pix + img + '?cid=' + cid + '&key=' + key);

          // download and pass to client
          const imageLink = pvalue[0].replace(/^\/\//g, 'http://');
          const bs64 = await this.downloadImage(imageLink);
          if(bs64) {
            socket.emit('showChapter', id, { index: i, src: bs64, lastpage: typeof retryIndex === 'number' ? true : i+1 === imagecount });
            continue;
          }
        }
        if(!cancel) socket.emit('showChapter', id, { error: 'chapter_error_fetch', index: i, lastpage: typeof retryIndex === 'number' ? true : i+1 === imagecount });
      }
      if(cancel) return;
    } catch(e) {
      this.logger('error while fetching chapter', e);
      // we catch any errors because the client needs to be able to handle them
      if(e instanceof Error) socket.emit('showChapter', id, {error: 'chapter_error', trace: e.message});
      else if(typeof e === 'string') socket.emit('showChapter', id, {error: 'chapter_error', trace: e});
      else socket.emit('showChapter', id, {error: 'chapter_error_unknown'});
    }
    return this.stopListening(socket);
  }

  async recommend(socket: socketInstance|Scheduler, id: number) {
    // we will check if user don't need results anymore at different intervals
    let cancel = false;
    if(!(socket instanceof Scheduler)) {
      socket.once('stopShowRecommend', () => {
        this.logger('fetching recommendations canceled');
        this.stopListening(socket);
        cancel = true;
      });
    }
    const url = `${this.host}/ranking/`;
    if(cancel) return; //=> 1st cancel check before request
    try {
      const $ = await this.fetch({
        url,
        cookies: [{name: 'isAdult', value: this.options.adult ? '1' : '0', path: '/', domain: 'fanfox.net'}],
        waitForSelector: '.container.dayrank.ranking',
      }, 'html');


      // we loop through the search results
      for(const el of $('ul.manga-list-1-list.line > li')) {

        if(cancel) break; //=> 2nd cancel check, break out of loop
        const subel = $('.manga-list-1-item-title > a', el);
        const name = subel.text().trim();
        const link = subel.attr('href')?.replace(this.host, '');
        const isMangaLink = this.isMangaPage(link||'');
        // safeguard
        if(!link || !isMangaLink || !name) continue;

        // mangafox images needs to be downloaded.
        const covers:string[] = [];
        const coverLink =  $('img.manga-list-1-cover', el).attr('src');
        if(coverLink) {
          const img = await this.downloadImage(coverLink);
          if(img) covers.push(img);
        }

        const searchResult = await this.searchResultsBuilder({
          name,
          url:link,
          covers,
          langs: this.langs,
        });

        // we return the results based on SearchResult model
        if(!cancel) socket.emit('showRecommend', id, searchResult);
      }
      if(cancel) return;
    } catch(e) {
        this.logger('error while recommending mangas', e);
        // we catch any errors because the client needs to be able to handle them
        if(e instanceof Error) socket.emit('showRecommend', id, {mirror: this.name, error: 'recommend_error', trace: e.message});
        else if(typeof e === 'string') socket.emit('showRecommend', id, {mirror: this.name, error: 'recommend_error', trace: e});
        else socket.emit('showRecommend', id, {mirror: this.name, error: 'recommend_error_unknown' });
    }
    socket.emit('showRecommend', id, { done: true });
    return this.stopListening(socket);
  }

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  #unpack(p, a, c, k, e, d):string {
    // credit mac @ AMR: https://gitlab.com/all-mangas-reader/all-mangas-reader-2/-/commit/316cf5e01c2182f13ea7a374cb05382030644bdf
    // the retrieved data is packed through an obfuscator
    // dm5 is unpacking the images url through an eval
    // we do it manually (below is the unpack function shipped with the data to decode)

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    e = function (c) {
        return (
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            (c < a ? '' : e(parseInt(c / a))) +
            ((c = c % a) > 35 ? String.fromCharCode(c + 29) : c.toString(36))
        );
    };
    if (!''.replace(/^/, String)) {
        while (c--) d[e(c)] = k[c] || e(c);
        k = [
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            function (e) {
                return d[e];
            },
        ];
        e = function () {
            return '\\w+';
        };
        c = 1;
    }
    while (c--) if (k[c]) p = p.replace(new RegExp('\\b' + e(c) + '\\b', 'g'), k[c]);
    return p;
  }
}

const mangafox = new Mangafox();
export default mangafox;
