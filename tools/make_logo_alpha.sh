#!/bin/sh
set -eu

# Preserve the official raster inside the dome and wordmark silhouettes while
# clearing only the white page outside them. A global white-color key would
# incorrectly erase the dome infill.
input=${1:-public/assets/MIT_HO_logo_square.jpg}
output=${2:-public/assets/mit-haystack.png}

ffmpeg -loglevel error -y -i "$input" -vf \
  "format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(gt(lte((X-489)*(X-489)+(Y-472)*(Y-472),214369)+between(X,14,966)*between(Y,846,1094),0),255,0)'" \
  -frames:v 1 "$output"
