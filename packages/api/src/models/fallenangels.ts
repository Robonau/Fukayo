import { MyMangaReaderCMS } from './abstracts/mymangareadercms';
import icon from './icons/fallenangels.png';

class FallenAngels extends MyMangaReaderCMS<{ enabled: boolean}> {
  constructor() {
    super({
      host: 'https://manga.fascans.com',
      name: 'fallenangels',
      displayName: 'Fallen Angels',
      langs: ['en'],
      icon,
      cache: true,
      manga_page_appended_string: 'Manga ',
      meta: {
        speed: 0.3,
        quality: 0.4,
        popularity: 0.3,
      },
      options: {
        enabled: true,
      },
    });
  }
}

const fa = new FallenAngels();
export default fa;
