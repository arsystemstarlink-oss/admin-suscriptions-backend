// Pruebas contra el emulador de Firestore. Se ejecutan con `npm run test:emulator`.
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/__tests__/emulator'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  testTimeout: 30000,
};
