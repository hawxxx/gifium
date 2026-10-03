declare module 'gifsicle-wasm' {
  interface Module {
    FS: { writeFile(path: string, bytes: Uint8Array): void; readFile(path: string): Uint8Array };
    _malloc(size: number): number;
    _free(pointer: number): void;
    stringToNewUTF8(value: string): number;
    setValue(pointer: number, value: number, type: string): void;
    _run_gifsicle(argc: number, argv: number): number;
  }
  export default function createModule(options: {
    wasmBinary: Uint8Array;
    print(value: string): void;
    printErr(value: string): void;
  }): Promise<Module>;
}
