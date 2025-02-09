#!/bin/bash
. .env

if [ $1 == "--cancel" ]
then
    yarn cancel
elif [ $1 == "--cancel-farm" ]
then
    yarn cancel-farm
elif [ $1 == "--cancel-immediately" ]
then
    yarn cancel-immediately
elif [ $1 == "--wash" ]
then
    yarn wash
elif [ $1 == "--wash-drop" ]
then
    yarn wash-drop
elif [ $1 == "--scan" ]
then
    yarn scan
elif [ $1 == "--check-hit" ]
then
    yarn check-hit
elif [ $1 == "--wick" ]
then
    yarn wick
elif [ $1 == "--wick-farm" ]
then
    yarn wick-farm
elif [ $1 == "--hedge" ]
then
    yarn hedge
elif [ $1 == "--ioc" ]
then
    yarn ioc
elif [ $1 == "--check-owner" ]
then
    yarn check-owner
elif [ $1 == "--competition" ]
then
    yarn competition
else
    yarn mm
fi
