#!/bin/bash
"$(dirname "$0")/stop.sh"
sleep 1
"$(dirname "$0")/start.sh"
