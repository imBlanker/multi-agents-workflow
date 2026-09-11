import { test } from "node:test";
import assert from "node:assert/strict";
import { platformFor } from "../src/platform/index.js";

test("Python task advice quotes spaced paths and preserves native interpreter preference", () => {
  const linux = platformFor("linux");
  assert.equal(linux.pythonCommand(["/work space/.trellis/scripts/task.py", "current"], n => n === "python3" ? "/usr/bin/python3" : null), "'/usr/bin/python3' '/work space/.trellis/scripts/task.py' 'current'");
  const windows = platformFor("win32");
  assert.equal(windows.pythonCommand(["C:/work space/task.py", "current"], n => n === "python" ? "C:/Python/python.exe" : null), "& 'C:/Python/python.exe' 'C:/work space/task.py' 'current'");
  assert.equal(windows.pythonCommand(["C:/work space/task.py", "current"], n => n === "py" ? "C:/Windows/py.exe" : null), "& 'C:/Windows/py.exe' '-3' 'C:/work space/task.py' 'current'");
});
