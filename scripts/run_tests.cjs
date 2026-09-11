const { execSync } = require("child_process");

console.log("------------------------------------------------------------");
console.log("NULL-FLOAT | Continuous Net Settlement Test Suite Runner");
console.log("------------------------------------------------------------\n");

try {
  execSync("npx hardhat test test/null_float.test.cjs", { stdio: "inherit" });
} catch (error) {
  process.exit(1);
}
