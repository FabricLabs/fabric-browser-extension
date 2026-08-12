let
  pkgs = import ./nix {};
in
  pkgs.mkShell {
    nativeBuildInputs = with pkgs; [
      coreutils
      git
      jq
      less
      niv
      nix-diff
      terraform
      which
    ];

    shellHook = ''
      # Needed for macOS, since the TMPDIR path is long there
      export TMPDIR=/tmp

      # Aliases (GNU vs BSD ls)
      if ls --color=auto -d . >/dev/null 2>&1; then
        alias ls='ls --color=auto'
      else
        alias ls='ls -G'
      fi
      alias l='ls -la'

      # Do not alias terraform private-key extraction into the shell (scrollback / history risk).
      # Retrieve deploy keys manually with explicit intent and chmod 600 files only.
      alias tf-get-deploy-public-key='terraform state pull | jq -r ".resources[] | select(.name == \"deploy\") | .instances[0].attributes.public_key_openssh"'
    '';
  }
