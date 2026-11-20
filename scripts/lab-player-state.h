#ifndef TALKQTE_LAB_PLAYER_STATE_H
#define TALKQTE_LAB_PLAYER_STATE_H
#include <stdint.h>
typedef struct lab_player_state lab_player_state;
lab_player_state *lab_player_state_create(void);
void lab_player_completed(lab_player_state *state, int callback_type);
int lab_player_completion(lab_player_state *state);
int lab_player_claim_completion(lab_player_state *state);
void lab_player_latch_stop(lab_player_state *state);
int lab_player_stopped(lab_player_state *state);
int lab_player_process_start(int pid, uint64_t *seconds, uint32_t *microseconds);
#endif
