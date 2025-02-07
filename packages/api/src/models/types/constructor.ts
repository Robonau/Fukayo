import type { mirrorsLangsType } from '@i18n/index';

export type MirrorConstructor<S = Record<string, unknown>, T = S & { enabled: boolean, cache:boolean }> = {
  /**
   * mirror's implementation version
   *
   * ⚠️ Mirror version must be incremented ONLY IF the mirror changed all of its mangas/chapter urls.
   * or you introduce some changes that breaks previous version of mangas in db
   *
   */
  version: number,
  /** is the mirror dead */
  isDead: boolean,
  /** slug name: `az-_` */
  name: string,
  /** full name */
  displayName: string,
  /**
   * hostname without ending slash
   * @example 'https://www.mirror.com'
   */
  host: string,
  /** alternative hostnames were the site can be reached */
  althost?: string[]
  /**
   * mirror icon (import)
   * @example
   * import icon from './my-mirror.png';
   * opts.icon = icon;
   */
  icon: string
  /**
   * Languages supported by the mirror
   *
   * ISO 639-1 codes
   */
  langs: mirrorsLangsType[],
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
  entryLanguageHasItsOwnURL?: boolean,
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
  }

  /** Requests limits */
  requestLimits: {
    /** time in ms between each requests (or each batch of concurrent requests) */
    time: number,
    /** number of requests that can be sent at once */
    concurrent: number
  }
  /**
   *
   */

  /**
   * Mirror specific option
   * @example { adult: true, lowres: false }
   */
  options: T
}
