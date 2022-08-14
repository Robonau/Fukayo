/**
 * Steno
 * https://github.com/typicode/steno
 * @license MIT
 * @sponsor https://github.com/sponsors/typicode
 */


/**
 *
 * The MIT License (MIT)
 *
 * Copyright (c) 2021 typicode
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import fs from 'fs';
import path from 'path';

// Returns a temporary file
// Example: for /some/file will return /some/.file.tmp
function getTempFilename(file: string): string {
  return path.join(path.dirname(file), '.' + path.basename(file) + '.tmp');
}

type Resolve = () => void
type Reject = (error: Error) => void

export class Writer {
  #filename: string;
  #tempFilename: string;
  #locked = false;
  #prev: [Resolve, Reject] | null = null;
  #next: [Resolve, Reject] | null = null;
  #nextPromise: Promise<void> | null = null;
  #nextData: string | null = null;

  // File is locked, add data for later
  #add(data: string): Promise<void> {
    // Only keep most recent data
    this.#nextData = data;

    // Create a singleton promise to resolve all next promises once next data is written
    this.#nextPromise ||= new Promise((resolve, reject) => {
      this.#next = [resolve, reject];
    });

    // Return a promise that will resolve at the same time as next promise
    return new Promise((resolve, reject) => {
      this.#nextPromise?.then(resolve).catch(reject);
    });
  }

  // File isn't locked, write data
  async #write(data: string): Promise<void> {
    // Lock file
    this.#locked = true;
    try {
      // Atomic write
      await fs.promises.writeFile(this.#tempFilename, data, 'utf-8');
      await fs.promises.rename(this.#tempFilename, this.#filename);

      // Call resolve
      this.#prev?.[0]();
    } catch (err) {
      // Call reject
      this.#prev?.[1](err as Error);
      throw err;
    } finally {
      // Unlock file
      this.#locked = false;

      this.#prev = this.#next;
      this.#next = this.#nextPromise = null;

      if (this.#nextData !== null) {
        const nextData = this.#nextData;
        this.#nextData = null;
        await this.write(nextData);
      }
    }
  }

  constructor(filename: string) {
    this.#filename = filename;
    this.#tempFilename = getTempFilename(filename);
  }

  async write(data: string): Promise<void> {
    return this.#locked ? this.#add(data) : this.#write(data);
  }
}
