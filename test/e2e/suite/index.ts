import Mocha from "mocha";
import path from "node:path";

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "tdd", color: true, timeout: 30_000 });
  mocha.addFile(path.resolve(__dirname, "extension.test.js"));
  return new Promise((resolvePromise, reject) => {
    mocha.run((failures) => {
      if (failures === 0) {
        resolvePromise();
      } else {
        reject(new Error(`${failures} Extension Host smoke test(s) failed.`));
      }
    });
  });
}
