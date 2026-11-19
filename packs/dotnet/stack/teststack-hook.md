# The AppHost's test-stack hook (dotnet pack)

The test stack is published from the application's Aspire AppHost (`stack.publish`: `aspire-publish.mjs`), so
the AppHost must be able to publish a Docker Compose file. `aspire-publish.mjs` runs `aspire publish` with
`TestStack=true`. The hook is the few lines that make that value publish to Docker Compose and leave every other
run as it was. The setup-teststack skill adds it as a repository decision; the person approves the change, because
it touches the application's composition.

1. Reference the Docker hosting integration at the AppHost's Aspire version:

   ```xml
   <!-- Directory.Packages.props, next to the other Aspire.Hosting packages -->
   <PackageVersion Include="Aspire.Hosting.Docker" Version="<the Aspire version>" />
   <!-- the AppHost .csproj -->
   <PackageReference Include="Aspire.Hosting.Docker" />
   ```

2. In the AppHost's entry file, choose the compute environment from the setting (keep the existing one in the
   `else` branch; add one only if the AppHost has none):

   ```csharp
   // Test stack hook (factory teststack publish): TestStack=true publishes the same resource graph as a Docker
   // Compose file for the factory's test stack instead of the production environment.
   var isTestStack = builder.Configuration["TestStack"] == "true";
   if (isTestStack)
   {
       builder.AddDockerComposeEnvironment("teststack");
   }
   else
   {
       builder.AddAzureContainerAppEnvironment("aca"); // whatever the AppHost used before
   }
   ```

3. When endpoints are chosen by launch profile (`https` by default), use plain HTTP in the test stack: the
   containers have no development certificate.

   ```csharp
   var launchProfileName = <existing condition> || isTestStack ? "http" : "https";
   ```

Nothing else changes in the AppHost. Everything that differs between the published stack and the test stack
(slot host ports, browser-facing URLs, seeding switched off, container ports) is a declared override in
`.factory/app.json` (`stack.publishOverrides`), each with its reason; see `aspire-publish.mjs`.

Check: `factory teststack publish` writes `.factory/stack/docker-compose.yaml`; `factory teststack drift` then
reports `"compared": true, "check": "clean"`.
