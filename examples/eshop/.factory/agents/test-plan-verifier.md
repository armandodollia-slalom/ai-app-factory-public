<!-- markdownlint-disable-file MD041 -->

### Interfaces a test can reach

HTTP, the UI, the database, a published event, and the AppHost model. State held inside another running process is not reachable: for example the token in the WebApp's server-side session.
