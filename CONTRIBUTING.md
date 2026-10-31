# Contributing

Thanks for helping. Security issues go through [SECURITY.md](SECURITY.md), not
public issues.

## Set up and check

```
npm install
npm test        # compile, then every test, including a short fuzz run
npm run fuzz    # a longer invariant-fuzzing campaign
npm run gas     # the gas table in the README
```

There is no node or compiler to install: the compiler is solc's WebAssembly
build, and the tests run on an in-process EVM.

## What a change needs

- **A test for the behaviour it adds or fixes.** For a safety check, also make
  sure the test fails when the check is removed.
- **The invariants still holding.** If the change touches money, run a fuzz
  campaign (`FUZZ_SEEDS=10 FUZZ_STEPS=1000 npm run fuzz`). If it adds an action
  or a way money moves, add it to `test/fuzz.mjs`.
- **Updated gas numbers** in the README when a change moves them noticeably.
- **Code that reads like the code around it:** the same naming and comment
  density, and custom errors rather than revert strings.

## License

Contributions are made under the Apache License 2.0, the project's license.
By opening a pull request you agree that your contribution is licensed under
it, as section 5 of the license describes.
