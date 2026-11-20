#include "lab-player-state.h"
#include <stdatomic.h>
#include <stdlib.h>
#include <libproc.h>
#include <sys/proc_info.h>
struct lab_player_state { atomic_int completion; atomic_int stopped; };
lab_player_state *lab_player_state_create(void) {
    lab_player_state *state = calloc(1, sizeof(*state));
    if (state && (!atomic_is_lock_free(&state->completion) || !atomic_is_lock_free(&state->stopped))) { free(state); return NULL; }
    if (state) { atomic_init(&state->completion, -1); atomic_init(&state->stopped, 0); }
    return state;
}
void lab_player_completed(lab_player_state *state, int type) {
    atomic_store_explicit(&state->completion, type, memory_order_release);
}
int lab_player_completion(lab_player_state *state) {
    return atomic_load_explicit(&state->completion, memory_order_acquire);
}
int lab_player_claim_completion(lab_player_state *state) {
    int expected = 0;
    return atomic_compare_exchange_strong_explicit(&state->stopped, &expected, 2, memory_order_acq_rel, memory_order_acquire);
}
void lab_player_latch_stop(lab_player_state *state) {
    atomic_store_explicit(&state->stopped, 1, memory_order_release);
}
int lab_player_stopped(lab_player_state *state) {
    return atomic_load_explicit(&state->stopped, memory_order_acquire);
}
int lab_player_process_start(int pid, uint64_t *seconds, uint32_t *microseconds) {
    struct proc_bsdinfo info;
    int size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
    if (size != sizeof(info) || info.pbi_start_tvsec == 0 || info.pbi_start_tvusec > 999999) return 0;
    *seconds = info.pbi_start_tvsec; *microseconds = (uint32_t)info.pbi_start_tvusec;
    return 1;
}
