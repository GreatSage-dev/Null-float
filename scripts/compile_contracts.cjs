const fs = require('fs');
const path = require('path');

// Resolve solc from local or sibling node_modules (e.g. tendon)
let solc;
try {
  solc = require('solc');
} catch (e) {
  try {
    solc = require(path.join(__dirname, '..', '..', '..', 'tendon', 'node_modules', 'solc'));
  } catch (err) {
    console.error("Could not resolve solc:", err);
    process.exit(1);
  }
}

function findSolFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      findSolFiles(filePath, fileList);
    } else if (file.endsWith('.sol')) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

function compile() {
  console.log("Compiling NULL-FLOAT Solidity contracts with solc " + solc.version() + "...");

  const contractsDir = path.join(__dirname, '..', 'contracts');
  const solFiles = findSolFiles(contractsDir);

  const sources = {};
  for (const filePath of solFiles) {
    const relPath = path.relative(path.join(__dirname, '..'), filePath).replace(/\\/g, '/');
    sources[relPath] = {
      content: fs.readFileSync(filePath, 'utf8')
    };
  }

  const input = {
    language: 'Solidity',
    sources: sources,
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      },
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object']
        }
      }
    }
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));

  if (output.errors) {
    let hasError = false;
    for (const err of output.errors) {
      if (err.severity === 'error') {
        hasError = true;
        console.error(err.formattedMessage);
      } else {
        console.warn(err.formattedMessage);
      }
    }
    if (hasError) {
      throw new Error("Compilation failed");
    }
  }

  const artifactsDir = path.join(__dirname, '..', 'artifacts');

  for (const [sourcePath, contracts] of Object.entries(output.contracts)) {
    for (const [contractName, contractData] of Object.entries(contracts)) {
      const contractArtifactDir = path.join(artifactsDir, sourcePath);
      fs.mkdirSync(contractArtifactDir, { recursive: true });

      const artifact = {
        _format: "hh-sol-artifact-1",
        contractName: contractName,
        sourceName: sourcePath,
        abi: contractData.abi,
        bytecode: "0x" + contractData.evm.bytecode.object,
        deployedBytecode: "0x" + contractData.evm.deployedBytecode.object,
        linkReferences: {},
        deployedLinkReferences: {}
      };

      const artifactPath = path.join(contractArtifactDir, `${contractName}.json`);
      fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
      console.log(`✓ Compiled ${contractName} -> ${path.relative(path.join(__dirname, '..'), artifactPath)}`);
    }
  }

  console.log("\nAll NULL-FLOAT contracts compiled successfully!");
}

compile();
