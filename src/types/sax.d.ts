declare module "sax" {
  export interface Tag {
    name: string;
    attributes: Record<string, string>;
  }
  export interface SAXParser {
    onopentag: ((tag: Tag) => void) | null;
    onclosetag: ((name: string) => void) | null;
    onerror: ((error: Error) => void) | null;
    write(chunk: string): SAXParser;
    close(): SAXParser;
  }
  export function parser(strict: boolean): SAXParser;
}
