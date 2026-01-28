# tedge-flows-examples

Experimental repository to exchange examples which use the upcoming tedge-flows feature.

## Building locally

You can build the flows locally with the following steps which requires nodejs >= 20.

1. Install the dependencies (using `npm ci` instead of `npm install` to install the exact versions defined in the package-lock.json file)

   ```sh
   npm ci
   ```

2. Build all the flows

   ```sh
   npm run build-all
   ```

Each bundled flow is stored under the `lib/main.js` of its flows directory. For example, for the `uptime` flow, the bundled file can be found under:

```sh
ls -l flows/uptime/lib/main.js
```

## Adding a new flow to the workspace

You can create a new flow (from a template) using the following command:

```sh
npm run generate-flow myflow1
```
