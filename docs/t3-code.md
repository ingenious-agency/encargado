# T3 Code configuration and usage

T3 Code creates worktrees and runs project actions. Encargado registers each
checkout, starts its declared dependencies and application, and owns its ports,
data and development URLs. An action calls the same CLI used from a terminal;
no Encargado plugin is required.

These UI labels and worktree behavior were checked against T3 Code
`0.0.46-nightly.20261007.2774`.

## Prepare the host and project

1. Install Encargado and start its user service as described in the
   [README](../README.md#run-it). Make `encargado` available on the PATH used by
   T3's terminals. With Mise and multiple Node installations, use the user-bin
   symlink from the README instead of relying on a global npm link in one Node
   installation.
2. Add a versioned `encargado.json` and configure the application's dependency
   ports, storage and launch recipe. Follow the [manifest contract](manifest.md)
   and, for Phoenix applications, the [Phoenix guide](phoenix.md). Use worktree
   scope for dependencies that need private data in each checkout.
3. Make the manifest, toolchain configuration and setup tasks available on the
   branch used to create worktrees. Git does not copy uncommitted changes or
   ignored dependency directories into a new checkout. Provide private
   environment files through the project's existing loader; keep credentials
   out of T3 action commands.
4. Configure [Tailscale routing](tailscale.md) once before using `encargado dev`
   for private HTTPS URLs. For local development, use `encargado dev web --local`
   in the actions below instead.

The commands below use the example service names `web` and `postgres`.
Substitute the names declared in your project's manifest. Dependency
installation and database preparation belong in the project's setup task or
registered launch recipe.

## Configure project actions

Open **Settings → Project**, select your project under **Applying settings for**
at the top, and scroll to **Actions**. Keep the project selected when visiting
other settings pages. Choose the environment where the checkout and Encargado
daemon run if T3 is connected to several machines.

Click **Add action** to create each action, or use the pencil beside an existing
action to edit it. Click **Save action** after entering its command and switches.

### Prepare worktree

Name the action **Prepare worktree**. Start with this template and replace the
setup comments with your project's documented commands before enabling it:

~~~sh
set -eu
MISE_NO_ENV=1 encargado register
# Install the project's toolchain and dependencies here.
# Prepare its database here if required.
encargado dev web
~~~

Set the switches as follows:

| Switch | Setting |
| --- | --- |
| Run automatically on worktree creation | On |
| Wait for it to finish before the agent starts | On |
| Run in the thread's worktree when the thread settles | Off |
| Open preview automatically when this action runs | Off |

The command runs from the new checkout; do not add a `cd` to the main checkout.
Registration happens before Mise evaluates project settings that call
`encargado get`. The command-scoped `MISE_NO_ENV=1` lets registration run before
those settings are available. Later commands load the registered values
normally. For a Mise project, add `MISE_NO_ENV=1 mise trust` before registration
if the checkout needs trust, then `mise install` after registration to install
the project's configured toolchain.

Ignored dependency directories are absent in a fresh worktree. Use the
project's dependency manager and setup tasks to install packages and prepare
assets. Setup task names and behavior vary by project; Encargado does not assume
a particular task exists. If setup needs a running database, insert
`encargado deps up` after toolchain installation and before the database setup
command.

`encargado dev web` starts the dependency graph and returns after readiness
checks complete. The application continues under a systemd user unit after the
action exits. The wait switch ensures preparation finishes before the agent
starts, and `set -eu` stops the action on a command failure.

### Stop worktree

Name the action **Stop worktree** and use this command:

~~~sh
encargado stop && encargado deps stop
~~~

Leave all automatic switches off. This is a manual action to run in the thread's
checkout before removing its worktree or when finishing development.

`stop` stops workloads; `deps stop` stops private dependencies. Together they
stop the checkout's workloads and private dependencies while retaining
containers, data and registered URLs. Other worktrees keep running. Shared
services and tooling services require explicit stopping by service name;
Encargado refuses to stop a dependency that still has a running consumer.

For a quick restart, optionally add a manual **Start worktree** action with
`encargado dev web`. Use **Prepare worktree** again when application
dependencies need installation.

T3 stores these action settings in its own user data, outside the application's
Git repository. Editing an action does not create a versioned application file.
To share the command through Git, put it in a project-owned script or task and
have the action invoke it. The application's manifest and setup recipe still
belong in its repository.

## Create and use a worktree

1. Start a new thread for the project and select a **Worktree** workspace with
   the intended base branch. A thread using the main checkout or an existing
   worktree does not trigger the creation action.
2. Let **Prepare worktree** finish. Its output includes the checkout's
   allocated ports and URLs. If it fails, inspect the failed command and rerun
   the action in that worktree after fixing the cause.
3. Open a returned HTTPS URL in the browser or T3 preview. Each checkout has its
   own URLs and ports; use the output instead of hardcoding one worktree's port
   into a project-wide preview setting.

Run manual actions from the thread's top-bar actions menu. For a checkout that
already existed before configuring the action, run **Prepare worktree**
manually once.

Use the thread's terminal to inspect the current checkout:

~~~sh
encargado status --json
encargado urls
encargado logs web
encargado logs postgres
~~~

`logs` reads recent output without changing the service's state. Use
`encargado status --all --json` to see the other registered checkouts. From a
terminal outside the checkout, pass `--path /absolute/path/to/worktree`.

Actions that start managed services should call Encargado. For example, use
`encargado dev web` for the app and `encargado deps up` for dependencies. A plain
`docker compose up` uses a different Compose project and does not receive
Encargado's allocated environment.

## Archive or delete a worktree

Archiving a thread preserves its conversation and worktree. Closing a terminal
or archiving a thread does not stop the application or dependencies.

This T3 version has creation and settlement action triggers, but no worktree
deletion trigger. **Stop worktree** does not run automatically when deleting
or archiving a thread. Settlement is a separate thread state, not a deletion
hook.

To remove a worktree through the T3 UI:

1. Commit any changes you want to keep, then run **Stop worktree** while the
   checkout still exists.
2. Right-click its thread and choose **Delete**. Archived threads are available
   under **Settings → Archive**.
3. If it is the only thread linked to that worktree, confirm **Delete the
   worktree too?**. With automatic cleanup disabled, this is a separate prompt.
   T3 keeps a worktree still used by another thread.

Deleting the thread permanently clears its conversation history. The UI's
confirmed worktree removal is forced and can discard uncommitted files. To keep
the conversation, archive the thread and remove the stopped worktree from the
main checkout's terminal instead:

~~~sh
git worktree remove /absolute/path/to/worktree
~~~

Without `--force`, Git refuses to remove a worktree containing local changes.
The branch is retained. The archived conversation remains available even though
its checkout has been removed.

Automatic removal rules are under **Settings → Storage → Worktrees**, with the
project still selected. **Automatic worktree cleanup → Off** keeps its
worktrees until manual removal. **Custom** exposes rules for deleted threads,
inactivity, merged work and unchanged worktrees. These rules remove checkouts;
they do not run the stop action or manage Encargado resources. Use **Off** when
cleanup must wait for an explicit stop.

## Retire an Encargado registration

Removing a Git worktree does not unregister it from Encargado or delete its
containers, named volumes or URLs. To retire the checkout's registration as
well, run the following from the checkout before deleting it, after stopping
its services:

~~~sh
encargado unexpose web
encargado unregister
~~~

Repeat `unexpose` for every registered HTTP service before `unregister`.
`unregister` preserves stopped containers and data. `unexpose` retires this
service's gateway routes and retains its Tailscale control-plane definition.
See [state and lifecycle](../README.md#state-and-lifecycle) for ownership and
recreation rules.
