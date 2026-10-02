#!/bin/sh
# Build the static site and publish it on chandler, where nginx serves it at
# https://jp127266.asuscomm.com/bookplate (see docs/chandler-bookplate-plan.md
# in the qt-audio repo). The new copy is unpacked beside the live one and
# swapped in, so visitors never see a half-uploaded site.
set -e
cd "$(dirname "$0")/.."
npx next build
COPYFILE_DISABLE=1 tar -C out --uid 0 --gid 0 -cf - . | ssh -o BatchMode=yes chandler '/bin/sh -c "
  set -e
  PATH=/bin:/usr/bin:/sbin:/usr/sbin
  W=/tmp/mnt/sda1/bookplate/www
  rm -rf \$W/bookplate.new
  mkdir -p \$W/bookplate.new
  tar -xf - -C \$W/bookplate.new
  chmod -R a+rX,go-w \$W/bookplate.new
  rm -rf \$W/bookplate.old
  [ -d \$W/bookplate ] && mv \$W/bookplate \$W/bookplate.old
  mv \$W/bookplate.new \$W/bookplate
  rm -rf \$W/bookplate.old
  echo deployed: \$(du -sh \$W/bookplate)
"'
