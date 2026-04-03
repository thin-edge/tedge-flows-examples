# tedge-flows-examples

Repository containing thin-edge.io flows to illustrate flows in a more production-like environment which covers;

- Repository structure that defines multiple
- Writing flows in TypeScript
- Using 3rd party dependencies within flows
- Transpile TypeScript to ES2018
- Writing unit test and run them, using Jest
- Packaging individual flows

The repository also uses Github workflows to run Pull Request checks, and also using an automated release process using [release-please](https://github.com/googleapis/release-please).

Feel-free to copy this repository and modify it to your liking, or you can also contribute new examples by raising a Pull Request.

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

3. Publish the flows (locally) so that they can be either uploaded to Cumulocity or manually installed

   ```sh
   npm run publish
   ```

   The files are located under the `dist/` directory

   ```sh
   $ ls -c1 dist/

   c8y%2Ftedge-measurement-batch_1.0.0.tar.gz
   c8y%2Fuptime_2.0.0.tar.gz
   local%2Fcertificate-alert_2.0.0.tar.gz
   local%2Fcloud-mapper-commands_0.1.0.tar.gz
   local%2Fcloud-mapper-telemetry_0.1.0.tar.gz
   local%2Fjsonata-xform_0.1.0.tar.gz
   local%2Flog-surge_2.0.0.tar.gz
   local%2Fmeasurement-aggregator_1.0.0.tar.gz
   local%2Fprotobuf-xform_1.0.0.tar.gz
   local%2Ftedge-config-context_1.0.1.tar.gz
   local%2Ftedge-events_1.0.0.tar.gz
   local%2Fx509-cert-issuer_1.0.0.tar.gz
   thingsboard%2Fthingsboard-registration_1.0.0.tar.gz
   thingsboard%2Fthingsboard-server-rpc_0.2.0.tar.gz
   thingsboard%2Fthingsboard-telemetry_1.0.0.tar.gz
   ```

## Adding a new flow to the workspace

You can create a new flow (from a template) using the following command:

```sh
npm run generate-flow myflow1
```
