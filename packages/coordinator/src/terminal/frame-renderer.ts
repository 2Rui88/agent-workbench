const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});
const WIDE=/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}　-〿！-｠]/u;
export function displayWidth(value: string): number { let width=0; for(const {segment} of segmenter.segment(value)) width+=WIDE.test(segment)?2:1; return width; }
// Clips to the display width (CJK and emoji take two columns) so a line can never wrap into the next row.
export function clip(value: string, columns: number): string {
  const clean=value.replace(/[\x00-\x1f\x7f-\x9f]/g,' ');
  const parts=[...segmenter.segment(clean)].map(({segment})=>({text:segment,width:WIDE.test(segment)?2:1}));
  const limit=Math.max(1,columns-1);
  if(parts.reduce((sum,part)=>sum+part.width,0)<=limit)return clean;
  let width=0;
  let result='';
  for(const part of parts){if(width+part.width>limit-1)break;result+=part.text;width+=part.width;}
  return result+'…';
}

// Wipes the shell prompt and the echoed exec line (screen and scrollback) once, before the very first frame.
export const INITIAL_CLEAR='\u001b[H\u001b[2J\u001b[3J';

// Paints one whole frame at a time: every row is addressed absolutely, overwritten in place and cleared to the end of
// the line. Apart from the one-time INITIAL_CLEAR the screen is never cleared and no newline is written, so the pane
// neither flickers nor scrolls, and a frame that did not change costs no bytes at all.
export class TerminalFrameRenderer {
  private previous='';
  private cursorHidden=false;
  private cleared=false;

  render(lines: string[], columns: number, rows: number): string {
    const height=Math.max(1,rows);
    const width=Math.max(2,columns);
    let frame='';
    for(let row=0;row<height;row++)frame+=`\u001b[${row+1};1H${clip(lines[row]??'',width)}\u001b[K`;
    const key=`${width}:${height}:${frame}`;
    if(key===this.previous)return '';
    this.previous=key;
    let output=frame;
    if(!this.cleared){output=INITIAL_CLEAR+output;this.cleared=true;}
    if(!this.cursorHidden){output='\u001b[?25l'+output;this.cursorHidden=true;}
    return output;
  }

  close(): string {
    if(!this.cursorHidden)return '';
    this.cursorHidden=false;
    return '\u001b[?25h';
  }
}
